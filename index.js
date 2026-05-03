require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { pool, initDB } = require('./db');

const port = process.env.PORT || 3000;
const url = process.env.APP_URL;

const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: { port: port } });
bot.setWebHook(`${url}/bot${process.env.BOT_TOKEN}`, { allowed_updates: ['message', 'callback_query'] });

const stringSession = new StringSession(process.env.STRING_SESSION);
const userBot = new TelegramClient(stringSession, parseInt(process.env.API_ID), process.env.API_HASH, {
    connectionRetries: 10,
    useWSS: true
});

const pendingCaptchas = new Map();
const userStates = new Map(); 
let resolvedGroupEntity = null; 

// --- HELPER: CLEAN UI ENGINE ---
// This function ensures the bot only uses one message block per user, editing it instead of spamming.
async function sendOrEdit(chatId, userId, text, options = {}) {
    const state = userStates.get(userId) || {};
    
    if (state.lastBotMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: state.lastBotMsgId, ...options });
            return;
        } catch (e) {
            // If the message was deleted or is exactly the same, fall through to send a new one
        }
    }
    
    const sentMsg = await bot.sendMessage(chatId, text, options);
    state.lastBotMsgId = sentMsg.message_id;
    userStates.set(userId, state);
}

// --- HELPER: MASK USERNAME ---
function maskUsername(username) {
    if (!username || username === 'None') return 'Unknown';
    if (username.length <= 4) return username[0] + '***';
    return username.substring(0, 2) + '***' + username.substring(username.length - 2);
}

async function isUserAllowed(userId) {
    const res = await pool.query('SELECT is_banned FROM users WHERE chat_id = $1', [userId]);
    if (res.rows.length > 0 && res.rows[0].is_banned) return false;
    return true;
}

async function trackUserActivity(msg, action) {
    const userId = msg.from.id;
    const adminId = process.env.ADMIN_ID;
    
    if (userId.toString() === adminId) return;

    const res = await pool.query('SELECT last_admin_msg_id, last_active_time, is_banned FROM users WHERE chat_id = $1', [userId]);
    if (res.rows.length === 0 || res.rows[0].is_banned) return;

    const now = Date.now();
    const lastActive = parseInt(res.rows[0].last_active_time) || 0;
    const lastMsgId = res.rows[0].last_admin_msg_id;
    const timeDiff = now - lastActive;
    const fifteenMins = 15 * 60 * 1000;

    const timeString = new Date().toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour12: false }); 
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    const username = msg.from.username ? `@${msg.from.username}` : 'None';

    const notificationText = `User Online:\nID: ${userId}\nName: ${name}\nUsername: ${username}\nLast Action: ${action}\nTime: ${timeString}`;

    if (timeDiff < fifteenMins && lastMsgId) {
        try {
            await bot.editMessageText(notificationText, { chat_id: adminId, message_id: lastMsgId });
            await pool.query('UPDATE users SET last_active_time = $1 WHERE chat_id = $2', [now, userId]);
        } catch (e) {
            sendNewNotification(userId, adminId, notificationText, now);
        }
    } else {
        sendNewNotification(userId, adminId, notificationText, now);
    }
}

async function sendNewNotification(userId, adminId, text, now) {
    try {
        const sentMsg = await bot.sendMessage(adminId, text);
        await pool.query('UPDATE users SET last_active_time = $1, last_admin_msg_id = $2 WHERE chat_id = $3', [now, sentMsg.message_id, userId]);
    } catch (e) {}
}

async function checkMembership(userId, username = null) {
    try {
        if (!resolvedGroupEntity) return false;

        try {
            const recentMembers = await userBot.getParticipants(resolvedGroupEntity, { limit: 100 });
            const foundInRecent = recentMembers.find(m => m.id.toString() === userId.toString());
            if (foundInRecent) return true; 
        } catch (scrapeErr) {}

        let targetEntity = null;
        if (username && username !== 'None') {
            try { targetEntity = await userBot.getEntity(username); } catch (err) {}
        }

        try {
            await userBot.invoke(new Api.channels.GetParticipant({
                channel: resolvedGroupEntity,
                participant: targetEntity ? targetEntity : userId
            }));
            return true; 
        } catch (apiErr) {
            const errStr = String(apiErr.message || apiErr.className || "").toUpperCase();
            if (errStr.includes('USER_NOT_PARTICIPANT') || errStr.includes('PARTICIPANT_ID_INVALID') || errStr.includes('INPUT_ENTITY')) return false; 
            if (apiErr.code === 420 || errStr.includes('FLOOD')) return true; 
            throw apiErr;
        }
    } catch (e) {
        return false; 
    }
}

async function auditUser(userId) {
    if (userId.toString() === process.env.ADMIN_ID) return false;

    const userRes = await pool.query('SELECT is_verified, balance, referred_by, username FROM users WHERE chat_id = $1', [userId]);
    
    if (userRes.rows.length > 0 && userRes.rows[0].is_verified) {
        const isStillMember = await checkMembership(userId, userRes.rows[0].username);
        
        if (!isStillMember) {
            const currentBalance = userRes.rows[0].balance;
            const referrer = userRes.rows[0].referred_by;

            await pool.query('UPDATE users SET balance = 0, is_verified = FALSE WHERE chat_id = $1', [userId]);
            await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'penalty_left_group', -currentBalance]);
            bot.sendMessage(userId, "System Audit Failed: You left the required group. Your account has been unverified and your balance reset to 0 NGN.").catch(()=>{});

            if (referrer) {
                await pool.query('UPDATE users SET balance = GREATEST(balance - 50, 0) WHERE chat_id = $1', [referrer]);
                await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [referrer, 'referral_penalty', -50]);
                bot.sendMessage(referrer, "Audit Alert: One of your verified referrals left the group. 50 NGN was deducted from your balance.").catch(()=>{});
            }
            return true; 
        }
    }
    return false; 
}

const mainInlineMenu = {
    reply_markup: {
        inline_keyboard: [
            [{ text: 'Tasks & Sign-in', callback_data: 'menu_tasks' }, { text: 'Invite Dashboard', callback_data: 'menu_invite' }],
            [{ text: 'My Balance', callback_data: 'menu_balance' }, { text: 'Top Referrers', callback_data: 'menu_toprefs' }],
            [{ text: 'Transaction Records', callback_data: 'menu_records' }],
            [{ text: 'Support', callback_data: 'menu_support' }]
        ]
    }
};

const cancelInlineMenu = {
    reply_markup: {
        inline_keyboard: [[{ text: 'Cancel Operation', callback_data: 'menu_main' }]]
    }
};

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    // Instantly delete the user's message to keep the chat clean
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    if (!(await isUserAllowed(userId))) return;

    const isAdmin = userId.toString() === process.env.ADMIN_ID;
    let state = userStates.get(userId) || {};

    if (text.startsWith('/start')) {
        const payload = text.split(' ')[1]; 
        const referredBy = payload ? parseInt(payload) : null;
        
        state.step = null;
        userStates.set(userId, state);

        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        
        if (res.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (chat_id, username, referred_by, is_verified) VALUES ($1, $2, $3, $4)',
                [userId, msg.from.username ? `@${msg.from.username}` : 'None', referredBy !== userId ? referredBy : null, isAdmin]
            );
        } else if (res.rows[0].is_verified || isAdmin) {
            await trackUserActivity(msg, "Started Bot");
            return sendOrEdit(chatId, userId, "Welcome back to your dashboard.", mainInlineMenu);
        }

        if (isAdmin) {
            return sendOrEdit(chatId, userId, "Welcome Admin. Verification bypassed.", mainInlineMenu);
        }

        const num1 = Math.floor(Math.random() * 10) + 1;
        const num2 = Math.floor(Math.random() * 10) + 1;
        pendingCaptchas.set(userId, { answer: num1 + num2, referredBy });

        return sendOrEdit(chatId, userId, `To proceed, please solve this simple math problem:\n\n${num1} + ${num2} = ?\n\nType the correct number below.`);
    }

    if (pendingCaptchas.has(userId)) {
        const expected = pendingCaptchas.get(userId).answer;
        if (parseInt(text) === expected) {
            pendingCaptchas.delete(userId);
            return sendOrEdit(chatId, userId, "Captcha passed!\n\nNow, you must join our group to use this bot.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Join Group", url: "https://t.me/+jgcu6IbmbisxOTM1" }],
                        [{ text: "Join Channel", url: "https://t.me/+Rci2m853ppA0NWY1" }],
                        [{ text: "I have joined", callback_data: "verify_join" }]
                    ]
                }
            });
        } else {
            return sendOrEdit(chatId, userId, "Incorrect. Type the correct answer, or send /start for a new captcha.");
        }
    }

    if (state.step) {
        if (text === '/cancel') {
            state.step = null;
            userStates.set(userId, state);
            return sendOrEdit(chatId, userId, "Operation cancelled.", mainInlineMenu);
        }

        if (state.step === 'AWAITING_BANK_NAME') {
            state.bank_name = text;
            state.step = 'AWAITING_ACCOUNT_NAME';
            userStates.set(userId, state);
            return sendOrEdit(chatId, userId, "Bank name saved. Now, type your Account Name:", cancelInlineMenu);
        }

        if (state.step === 'AWAITING_ACCOUNT_NAME') {
            state.account_name = text;
            state.step = 'AWAITING_ACCOUNT_NUMBER';
            userStates.set(userId, state);
            return sendOrEdit(chatId, userId, "Account name saved. Finally, type your Account Number:", cancelInlineMenu);
        }

        if (state.step === 'AWAITING_ACCOUNT_NUMBER') {
            try {
                await pool.query(
                    'UPDATE users SET bank_name = $1, account_name = $2, account_number = $3 WHERE chat_id = $4',
                    [state.bank_name, state.account_name, text, userId]
                );
                state.step = null;
                userStates.set(userId, state);
                return sendOrEdit(chatId, userId, "Your bank information has been successfully saved.", mainInlineMenu);
            } catch (err) {
                state.step = null;
                userStates.set(userId, state);
                if (err.code === '23505') {
                    return sendOrEdit(chatId, userId, "Error: This account number is already registered to another user.", mainInlineMenu);
                }
                return sendOrEdit(chatId, userId, "An error occurred while saving your details.", mainInlineMenu);
            }
        }

        if (state.step === 'AWAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = state.user;
            const minWithdraw = parseInt(process.env.MIN_WITHDRAW) || 500;

            if (isNaN(amount) || amount < minWithdraw) {
                return sendOrEdit(chatId, userId, `Please enter a valid number that is at least ${minWithdraw.toLocaleString()}.`, cancelInlineMenu);
            }

            if (amount > user.balance) {
                return sendOrEdit(chatId, userId, `Insufficient balance. Your current balance is ${user.balance.toLocaleString()} NGN.`, cancelInlineMenu);
            }

            try {
                await pool.query('UPDATE users SET balance = balance - $1 WHERE chat_id = $2', [amount, userId]);
                const txRes = await pool.query('INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4) RETURNING id', [userId, 'withdrawal', amount, 'pending']);
                const txId = txRes.rows[0].id;
                
                state.step = null;
                userStates.set(userId, state);
                sendOrEdit(chatId, userId, "Withdrawal submitted successfully. Waiting for admin approval...", mainInlineMenu);

                const adminMessage = `New Withdrawal Request:\n\nUser ID: ${userId}\nUsername: ${user.username || 'None'}\nAmount: ${amount.toLocaleString()} NGN\n\nBank: ${user.bank_name}\nName: ${user.account_name}\nAccount: ${user.account_number}`;
                bot.sendMessage(process.env.ADMIN_ID, adminMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Approve", callback_data: `approve_${txId}_${userId}_${amount}` }],
                            [{ text: "Reject", callback_data: `reject_${txId}_${userId}_${amount}` }]
                        ]
                    }
                });
            } catch (err) {
                sendOrEdit(chatId, userId, "An error occurred while processing your withdrawal.", mainInlineMenu);
            }
            return;
        }
    }

    // --- TEXT COMMAND FALLBACKS (If user manually types them) ---
    const userStatus = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
    const isVerified = userStatus.rows.length > 0 && userStatus.rows[0].is_verified;

    if (!isVerified && !isAdmin && !text.startsWith('/start')) {
        return sendOrEdit(chatId, userId, "You must complete the verification process first.");
    }

    if (text === '/signin') {
        processSignin(chatId, userId, msg);
    } 
    else if (text === '/toprefs') {
        processTopRefs(chatId, userId, msg);
    }
    else if (text === '/setbank') {
        state.step = 'AWAITING_BANK_NAME';
        userStates.set(userId, state);
        sendOrEdit(chatId, userId, "Please type your Bank Name:", cancelInlineMenu);
    }
    else if (text === '/withdraw') {
        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        const user = res.rows[0];
        if (!user.bank_name || !user.account_name || !user.account_number) {
            return sendOrEdit(chatId, userId, "You have not set your bank info yet. Please click 'Set Bank Details' in your balance menu.", mainInlineMenu);
        }
        state.step = 'AWAITING_WITHDRAW_AMOUNT';
        state.user = user;
        userStates.set(userId, state);
        sendOrEdit(chatId, userId, `Type the amount you want to withdraw (Min: ${process.env.MIN_WITHDRAW || 500} NGN):`, cancelInlineMenu);
    }
});

// --- MENU ACTION PROCESSORS ---
async function processSignin(chatId, userId, msg) {
    if (await auditUser(userId)) return;
    await trackUserActivity(msg, "Attempted Sign-in");

    const refCheck = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by = $1 AND is_verified = TRUE', [userId]);
    if (parseInt(refCheck.rows[0].count) === 0) {
        return sendOrEdit(chatId, userId, "You cannot sign in yet. You must have at least 1 verified referral to unlock daily sign-ins.", mainInlineMenu);
    }

    const todayCheck = await pool.query(`SELECT id FROM transactions WHERE chat_id = $1 AND type = 'signin_bonus' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
    if (todayCheck.rows.length > 0) {
        return sendOrEdit(chatId, userId, "You have already claimed your daily sign-in bonus today. Come back tomorrow!", mainInlineMenu);
    }

    await pool.query('UPDATE users SET balance = balance + 10 WHERE chat_id = $1', [userId]);
    await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'signin_bonus', 10]);
    
    sendOrEdit(chatId, userId, "Sign-in successful! 10 NGN has been added to your balance.", mainInlineMenu);
}

async function processTopRefs(chatId, userId, msg) {
    if (await auditUser(userId)) return;
    await trackUserActivity(msg, "Checked Leaderboard");
    const isAdmin = userId.toString() === process.env.ADMIN_ID;

    const res = await pool.query(`
        SELECT u.username, COUNT(r.chat_id) as ref_count 
        FROM users u 
        JOIN users r ON r.referred_by = u.chat_id 
        WHERE r.is_verified = TRUE 
        GROUP BY u.chat_id, u.username 
        ORDER BY ref_count DESC 
        LIMIT 10
    `);

    if (res.rows.length === 0) {
        return sendOrEdit(chatId, userId, "The leaderboard is currently empty.", mainInlineMenu);
    }

    let board = "Top 10 Referrers:\n\n";
    res.rows.forEach((row, index) => {
        const displayNick = isAdmin ? (row.username || 'Unknown') : maskUsername(row.username);
        board += `${index + 1}. ${displayNick} - ${row.ref_count} invites\n`;
    });

    sendOrEdit(chatId, userId, board, mainInlineMenu);
}

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!(await isUserAllowed(userId))) return bot.answerCallbackQuery(query.id);

    // --- NAVIGATION CALLBACKS ---
    if (data === 'menu_main') {
        let state = userStates.get(userId) || {};
        state.step = null;
        userStates.set(userId, state);
        return sendOrEdit(chatId, userId, "Main Dashboard", mainInlineMenu);
    }

    if (data === 'menu_tasks') {
        bot.answerCallbackQuery(query.id);
        const taskMenu = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Claim Daily Sign-In (10 NGN)', callback_data: 'action_signin' }],
                    [{ text: 'Back to Menu', callback_data: 'menu_main' }]
                ]
            }
        };
        return sendOrEdit(chatId, userId, "Task Center:\n\nDaily Sign-in Requires at least 1 verified referral.", taskMenu);
    }

    if (data === 'action_signin') {
        bot.answerCallbackQuery(query.id);
        return processSignin(chatId, userId, query.message);
    }

    if (data === 'menu_toprefs') {
        bot.answerCallbackQuery(query.id);
        return processTopRefs(chatId, userId, query.message);
    }

    if (data === 'menu_invite') {
        bot.answerCallbackQuery(query.id);
        if (await auditUser(userId)) return;
        await trackUserActivity(query.message, "Opened Invite Dashboard");
        
        bot.getMe().then(async (botInfo) => {
            const inviteLink = `https://t.me/${botInfo.username}?start=${userId}`;
            
            const refQuery = await pool.query('SELECT username, is_verified FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 15', [userId]);
            const totalRefs = refQuery.rows.length;
            const verifiedRefs = refQuery.rows.filter(r => r.is_verified).length;

            let dashMsg = `Your Invite Dashboard\n\nLink: ${inviteLink}\nReward: ${parseInt(process.env.REFERRAL_REWARD).toLocaleString()} NGN per verified user.\n\nTotal Invites: ${totalRefs}\nVerified Invites: ${verifiedRefs}\n\nRecent Referrals:\n`;
            
            if (totalRefs === 0) {
                dashMsg += "No referrals yet.";
            } else {
                refQuery.rows.forEach((r, i) => {
                    const status = r.is_verified ? "Verified" : "Pending";
                    dashMsg += `${i + 1}. ${r.username || 'Unknown'} - ${status}\n`;
                });
            }

            sendOrEdit(chatId, userId, dashMsg, {
                reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_main' }]] }
            });
        });
        return;
    }

    if (data === 'menu_balance') {
        bot.answerCallbackQuery(query.id);
        if (await auditUser(userId)) return;
        await trackUserActivity(query.message, "Checked Balance");
        const balanceRes = await pool.query('SELECT balance, bank_name, account_number FROM users WHERE chat_id = $1', [userId]);
        
        if (balanceRes.rows.length > 0) {
            const user = balanceRes.rows[0];
            const bankStatus = user.bank_name ? `${user.bank_name} (${user.account_number})` : "Not Set";
            
            const balMenu = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Withdraw Funds', callback_data: 'action_withdraw' }],
                        [{ text: 'Set Bank Details', callback_data: 'action_setbank' }],
                        [{ text: 'Back to Menu', callback_data: 'menu_main' }]
                    ]
                }
            };
            sendOrEdit(chatId, userId, `Your Wallet\n\nBalance: ${user.balance.toLocaleString()} NGN\nBank Info: ${bankStatus}`, balMenu);
        }
        return;
    }

    if (data === 'action_setbank') {
        bot.answerCallbackQuery(query.id);
        let state = userStates.get(userId) || {};
        state.step = 'AWAITING_BANK_NAME';
        userStates.set(userId, state);
        return sendOrEdit(chatId, userId, "Please type your Bank Name below:", cancelInlineMenu);
    }

    if (data === 'action_withdraw') {
        bot.answerCallbackQuery(query.id);
        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        const user = res.rows[0];
        if (!user.bank_name || !user.account_name || !user.account_number) {
            return sendOrEdit(chatId, userId, "You have not set your bank info yet. Please click 'Set Bank Details' first.", {
                reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: 'menu_balance' }]] }
            });
        }
        let state = userStates.get(userId) || {};
        state.step = 'AWAITING_WITHDRAW_AMOUNT';
        state.user = user;
        userStates.set(userId, state);
        return sendOrEdit(chatId, userId, `Type the amount you want to withdraw (Min: ${process.env.MIN_WITHDRAW || 500} NGN):`, cancelInlineMenu);
    }

    if (data === 'menu_records') {
        bot.answerCallbackQuery(query.id);
        if (await auditUser(userId)) return;
        await trackUserActivity(query.message, "Checked Records");

        const res = await pool.query('SELECT type, amount, status, created_at FROM transactions WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]);
        
        let recordMsg = "Your Last 10 Transactions:\n\n";
        if (res.rows.length === 0) {
            recordMsg += "No records found.";
        } else {
            res.rows.forEach(r => {
                const date = new Date(r.created_at).toLocaleString();
                recordMsg += `Type: ${r.type.toUpperCase()}\nAmount: ${r.amount.toLocaleString()} NGN\nStatus: ${r.status.toUpperCase()}\nDate: ${date}\n\n`;
            });
        }

        return sendOrEdit(chatId, userId, recordMsg, {
            reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_main' }]] }
        });
    }

    if (data === 'menu_support') {
        bot.answerCallbackQuery(query.id);
        await trackUserActivity(query.message, "Clicked Support");
        return sendOrEdit(chatId, userId, `For any inquiries, please contact ${process.env.SUPPORT_USERNAME}`, {
            reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_main' }]] }
        });
    }

    // --- VERIFICATION & ADMIN CALLBACKS ---
    if (data === 'verify_join') {
        await trackUserActivity(query.message, "Clicked Verify Join");
        const username = query.from.username ? `@${query.from.username}` : null;
        const isMember = await checkMembership(userId, username);
        
        if (isMember) {
            await pool.query('UPDATE users SET is_verified = TRUE, balance = balance + 100 WHERE chat_id = $1', [userId]);
            await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'welcome_bonus', 100]);
            
            const userRes = await pool.query('SELECT referred_by FROM users WHERE chat_id = $1', [userId]);
            const referrer = userRes.rows[0]?.referred_by;
            
            if (referrer) {
                const refReward = parseInt(process.env.REFERRAL_REWARD);
                await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [refReward, referrer]);
                await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [referrer, 'referral_bonus', refReward]);
                bot.sendMessage(referrer, `Your referral has been verified! You earned ${refReward.toLocaleString()} NGN.`).catch(()=>{});
            }
            bot.answerCallbackQuery(query.id, { text: "Verification successful!" });
            return sendOrEdit(chatId, userId, "Verification successful! You received a 100 NGN welcome bonus.", mainInlineMenu);
        } else {
            return bot.answerCallbackQuery(query.id, { text: "You haven't joined the required group yet. Please join and try again.", show_alert: true });
        }
    }

    if (data.startsWith('approve_') && userId.toString() === process.env.ADMIN_ID) {
        const parts = data.split('_');
        const txId = parts[1];
        const targetUser = parts[2];
        await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
        bot.editMessageText(query.message.text + "\n\nStatus: APPROVED", { chat_id: chatId, message_id: query.message.message_id });
        bot.sendMessage(targetUser, "Your withdrawal request has been approved and processed.").catch(()=>{});
    }

    if (data.startsWith('reject_') && userId.toString() === process.env.ADMIN_ID) {
        const parts = data.split('_');
        const txId = parts[1];
        const targetUser = parts[2];
        const amount = parseInt(parts[3]);
        await pool.query("UPDATE transactions SET status = 'rejected' WHERE id = $1", [txId]);
        await pool.query("UPDATE users SET balance = balance + $1 WHERE chat_id = $2", [amount, targetUser]);
        await pool.query("INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4)", [targetUser, 'refund', amount, 'completed']);
        bot.editMessageText(query.message.text + "\n\nStatus: REJECTED (Refunded)", { chat_id: chatId, message_id: query.message.message_id });
        bot.sendMessage(targetUser, `Your withdrawal of ${amount.toLocaleString()} NGN was rejected. The funds have been refunded to your bot balance.`).catch(()=>{});
    }
});

bot.onText(/\/audit/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    let statusMsg = await bot.sendMessage(chatId, "Starting manual audit. This may take a moment...");
    try {
        const users = await pool.query('SELECT chat_id FROM users WHERE is_verified = TRUE');
        let penalizedCount = 0;
        for (let row of users.rows) {
            const penalized = await auditUser(row.chat_id);
            if (penalized) penalizedCount++;
            await new Promise(r => setTimeout(r, 1000));
        }
        bot.editMessageText(`Audit complete. Penalized ${penalizedCount} user(s) who left the group.`, { chat_id: chatId, message_id: statusMsg.message_id });
    } catch (e) {
        bot.editMessageText("An error occurred during the audit.", { chat_id: chatId, message_id: statusMsg.message_id });
    }
});

(async () => {
    await initDB();
    console.log("Connecting UserBot...");
    await userBot.connect();
    console.log("UserBot connected.");

    console.log("Scanning chats for the group...");
    const dialogs = await userBot.getDialogs();
    for (const dialog of dialogs) {
        if (dialog.title && dialog.title.includes('M4U-Nigeria')) {
            resolvedGroupEntity = dialog.entity;
            console.log(`Found group: ${dialog.title}`);
            break;
        }
    }
    if (!resolvedGroupEntity) {
        console.log("WARNING: Could not find M4U-Nigeria in userbot's chat list.");
    }
    console.log(`Main bot is running on Webhooks, port: ${port}`);
})();
