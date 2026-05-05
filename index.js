require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { pool, initDB } = require('./db');
const axios = require('axios'); 

const port = process.env.PORT || 3000;
const url = process.env.APP_URL;

// Initialize bot
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
async function replaceMessage(chatId, userId, text, options = {}) {
    const state = userStates.get(userId) || {};
    
    if (state.lastBotMsgId) {
        bot.deleteMessage(chatId, state.lastBotMsgId).catch(() => {});
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
    } catch (e) { return false; }
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
            bot.sendMessage(userId, "System Audit Failed: You left the required group. Your account has been unverified and your balance reset to 0 NGN.", { reply_markup: { remove_keyboard: true } }).catch(()=>{});
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

const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Task' }, { text: 'Invite Dashboard' }],
            [{ text: 'Balance' }, { text: 'Top Referrers' }],
            [{ text: 'Records' }, { text: 'Support' }]
        ],
        resize_keyboard: true
    }
};

const cancelMenu = {
    reply_markup: {
        keyboard: [[{ text: 'Cancel' }]],
        resize_keyboard: true
    }
};

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    // --- 1. CHAT-TO-EARN ENGINE (GROUP MESSAGES) ---
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        const targetGroupId = process.env.GROUP_ID; 
        if (chatId.toString() !== targetGroupId) return;
        try {
            const userRes = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
            if (userRes.rows.length === 0 || !userRes.rows[0].is_verified) return;
            const reward = parseInt(process.env.MESSAGE_REWARD) || 3;
            const maxDaily = parseInt(process.env.MAX_DAILY_CHAT) || 100;
            const todayCheck = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE chat_id = $1 AND type = 'chat_reward' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
            const earnedToday = parseInt(todayCheck.rows[0].total);
            if (earnedToday < maxDaily) {
                const amountToGive = Math.min(reward, maxDaily - earnedToday);
                await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [amountToGive, userId]);
                await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'chat_reward', amountToGive]);
            }
        } catch (err) {}
        return; 
    }

    // --- 2. DASHBOARD ENGINE (PRIVATE MESSAGES) ---
    if (msg.chat.type !== 'private') return;

    // FIX: Allow /setbank and /withdraw to pass through the dashboard filter
    const userCommands = ['/setbank', '/withdraw', '/signin', '/toprefs', '/records', '/start'];
    const isUserCmd = userCommands.some(cmd => text.startsWith(cmd));

    if (text.startsWith('/')) {
        if (!isUserCmd) return; // If it's a command but NOT one of ours, stop (Admin commands handled by bot.onText)
    } else {
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    if (!(await isUserAllowed(userId))) return;

    const isAdmin = userId.toString() === process.env.ADMIN_ID;
    let state = userStates.get(userId) || {};

    if (text === 'Cancel' || text === '/cancel') {
        state.step = null;
        userStates.set(userId, state);
        return replaceMessage(chatId, userId, "Operation cancelled.", mainMenu);
    }

    if (text.startsWith('/start')) {
        const payload = text.split(' ')[1]; 
        const referredBy = payload ? parseInt(payload) : null;
        state.step = null;
        userStates.set(userId, state);
        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        if (res.rows.length === 0) {
            await pool.query('INSERT INTO users (chat_id, username, referred_by, is_verified) VALUES ($1, $2, $3, $4)', [userId, msg.from.username ? `@${msg.from.username}` : 'None', referredBy !== userId ? referredBy : null, isAdmin]);
        } else if (res.rows[0].is_verified || isAdmin) {
            await trackUserActivity(msg, "Started Bot");
            return replaceMessage(chatId, userId, "Welcome back to your dashboard.", mainMenu);
        }
        if (isAdmin) { return replaceMessage(chatId, userId, "Welcome Admin. Verification bypassed.", mainMenu); }
        const num1 = Math.floor(Math.random() * 10) + 1;
        const num2 = Math.floor(Math.random() * 10) + 1;
        pendingCaptchas.set(userId, { answer: num1 + num2, referredBy });
        return replaceMessage(chatId, userId, `To proceed, please solve this simple math problem:\n\n${num1} + ${num2} = ?\n\nType the correct number below.`);
    }

    if (pendingCaptchas.has(userId)) {
        const expected = pendingCaptchas.get(userId).answer;
        if (parseInt(text) === expected) {
            pendingCaptchas.delete(userId);
            return replaceMessage(chatId, userId, "Captcha passed!\n\nNow, you must join our group to use this bot.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Join Group", url: "https://t.me/+jgcu6IbmbisxOTM1" }],
                        [{ text: "Join Channel", url: "https://t.me/+Rci2m853ppA0NWY1" }],
                        [{ text: "I have joined", callback_data: "verify_join" }]
                    ]
                }
            });
        } else { return replaceMessage(chatId, userId, "Incorrect. Type the correct answer, or send /start for a new captcha."); }
    }

    if (state.step) {
        if (state.step === 'AWAITING_ACCOUNT_NAME') {
            state.account_name = text;
            state.step = 'AWAITING_ACCOUNT_NUMBER';
            userStates.set(userId, state);
            return replaceMessage(chatId, userId, "Account name saved. Finally, type your Account Number (Must be exactly 10 digits):", cancelMenu);
        }

        if (state.step === 'AWAITING_ACCOUNT_NUMBER') {
            if (!/^\d{10}$/.test(text)) { return replaceMessage(chatId, userId, "Invalid input. Your account number must be exactly 10 digits. Please try again:", cancelMenu); }
            try {
                await pool.query('UPDATE users SET bank_name = $1, account_name = $2, account_number = $3 WHERE chat_id = $4', [state.bank_name, state.account_name, text, userId]);
                state.step = null;
                userStates.set(userId, state);
                return replaceMessage(chatId, userId, "Your bank information has been successfully saved.", mainMenu);
            } catch (err) {
                state.step = null; userStates.set(userId, state);
                if (err.code === '23505') { return replaceMessage(chatId, userId, "Error: This account number is already registered to another user.", mainMenu); }
                return replaceMessage(chatId, userId, "An error occurred while saving your details.", mainMenu);
            }
        }

        if (state.step === 'AWAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = state.user;
            const minWithdraw = parseInt(process.env.MIN_WITHDRAW) || 500;
            if (isNaN(amount) || amount < minWithdraw) { return replaceMessage(chatId, userId, `Please enter a valid number that is at least ${minWithdraw.toLocaleString()}.`, cancelMenu); }
            if (amount > user.balance) { return replaceMessage(chatId, userId, `Insufficient balance. Your current balance is ${user.balance.toLocaleString()} NGN.`, cancelMenu); }

            const failedAudit = await auditUser(userId);
            if (failedAudit) { state.step = null; userStates.set(userId, state); return; }

            let txId; 
            try {
                await pool.query('UPDATE users SET balance = balance - $1 WHERE chat_id = $2', [amount, userId]);
                const txRes = await pool.query('INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4) RETURNING id', [userId, 'withdrawal', amount, 'pending']);
                txId = txRes.rows[0].id;
                state.step = null; userStates.set(userId, state);
                await replaceMessage(chatId, userId, "Processing...", mainMenu);

                const bankCodes = { 'Opay': '090399', 'Palmpay': '090328', 'Kuda': '090267', 'Moniepoint': '090405' };
                const flwBankCode = bankCodes[user.bank_name];
                const flwPayload = {
                    account_bank: flwBankCode, account_number: user.account_number, amount: amount, narration: "M4U-Nigeria Reward", currency: "NGN", reference: `M4U_AUTO_${txId}_${Date.now()}`
                };
                const flwResponse = await axios.post('https://api.flutterwave.com/v3/transfers', flwPayload, { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` } });

                if (flwResponse.data.status === "success") {
                    await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
                    replaceMessage(chatId, userId, `Withdrawal Successful!\n\n${amount.toLocaleString()} NGN has been sent to your ${user.bank_name} account.`, mainMenu);
                } else { throw new Error("Flutterwave returned a non-success status."); }
            } catch (err) {
                replaceMessage(chatId, userId, "Network issue. Forwarded to admin for manual review.", mainMenu);
                if (txId) {
                    const adminMsg = `Auto-Payout Failed User: ${userId}\nAmount: ${amount} NGN\nBank: ${user.bank_name}\nAcc: ${user.account_number}\n/approve ${txId}`;
                    bot.sendMessage(process.env.ADMIN_ID, adminMsg, { reply_markup: { inline_keyboard: [[{ text: "Approve Manually", callback_data: `approve_${txId}_${userId}_${amount}` }]] } });
                }
            }
            return;
        }
    }

    const userStatus = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
    const isVerified = userStatus.rows.length > 0 && userStatus.rows[0].is_verified;

    if (!isVerified && !isAdmin && !text.startsWith('/start')) {
        return replaceMessage(chatId, userId, "You must complete the verification process first.", { reply_markup: { remove_keyboard: true }});
    }

    if (text === 'Task') {
        if (await auditUser(userId)) return;
        await trackUserActivity(msg, "Checked Tasks");
        replaceMessage(chatId, userId, "*Task Center*\n\n*1. Daily Sign-in* - /signin\n*2. Chat to Earn*\nEarn 3 NGN per message in group!\nMax: 100 NGN daily.", { parse_mode: 'Markdown', ...mainMenu });
    } 
    else if (text === '/signin') {
        if (await auditUser(userId)) return;
        const refCheck = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by = $1 AND is_verified = TRUE AND created_at >= date_trunc(\'day\', now() AT TIME ZONE \'Africa/Lagos\')', [userId]);
        if (parseInt(refCheck.rows[0].count) === 0) { return replaceMessage(chatId, userId, "Need 1 verified referral today to sign in.", mainMenu); }
        const todayCheck = await pool.query(`SELECT id FROM transactions WHERE chat_id = $1 AND type = 'signin_bonus' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
        if (todayCheck.rows.length > 0) { return replaceMessage(chatId, userId, "Already claimed today.", mainMenu); }
        await pool.query('UPDATE users SET balance = balance + 10 WHERE chat_id = $1', [userId]);
        await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'signin_bonus', 10]);
        replaceMessage(chatId, userId, "Sign-in successful!", mainMenu);
    }
    else if (text === 'Balance') {
        const balanceRes = await pool.query('SELECT balance, bank_name, account_number FROM users WHERE chat_id = $1', [userId]);
        if (balanceRes.rows.length > 0) {
            const user = balanceRes.rows[0];
            const bankStatus = user.bank_name ? `${user.bank_name} (${user.account_number})` : "Not Set";
            replaceMessage(chatId, userId, `Wallet\n\nBalance: ${user.balance.toLocaleString()} NGN\nBank: ${bankStatus}\n\n/withdraw | /setbank`, mainMenu);
        }
    } 
    else if (text === '/setbank') {
        state.step = 'AWAITING_BANK_SELECTION'; userStates.set(userId, state);
        const bankMenu = { reply_markup: { inline_keyboard: [[{ text: 'Opay', callback_data: 'bank_Opay' }, { text: 'Palmpay', callback_data: 'bank_Palmpay' }], [{ text: 'Kuda', callback_data: 'bank_Kuda' }, { text: 'Moniepoint', callback_data: 'bank_Moniepoint' }], [{ text: 'Cancel', callback_data: 'cancel_op' }]] } };
        replaceMessage(chatId, userId, "Select your Bank Name:", bankMenu);
    }
    else if (text === '/withdraw') {
        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        const user = res.rows[0];
        if (!user.bank_name) { return replaceMessage(chatId, userId, "Set bank info first. /setbank", mainMenu); }
        const todayW = await pool.query(`SELECT id FROM transactions WHERE chat_id = $1 AND type = 'withdrawal' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
        if (todayW.rows.length > 0) { return replaceMessage(chatId, userId, "Only one withdrawal per day.", mainMenu); }
        state.step = 'AWAITING_WITHDRAW_AMOUNT'; state.user = user; userStates.set(userId, state);
        replaceMessage(chatId, userId, `Type amount to withdraw (Min: ${process.env.MIN_WITHDRAW || 500}):`, cancelMenu);
    }
});

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!(await isUserAllowed(userId))) return bot.answerCallbackQuery(query.id);

    if (data.startsWith('bank_')) {
        const bank = data.split('_')[1];
        let state = userStates.get(userId) || {};
        state.bank_name = bank; state.step = 'AWAITING_ACCOUNT_NAME'; userStates.set(userId, state);
        bot.answerCallbackQuery(query.id);
        return replaceMessage(chatId, userId, `Bank saved: ${bank}\nNow, type your Account Name:`, cancelMenu);
    }
    if (data === 'cancel_op') {
        let state = userStates.get(userId) || {}; state.step = null; userStates.set(userId, state);
        bot.answerCallbackQuery(query.id); return replaceMessage(chatId, userId, "Cancelled.", mainMenu);
    }
    if (data === 'verify_join') {
        const isMember = await checkMembership(userId, query.from.username);
        if (isMember) {
            await pool.query('UPDATE users SET is_verified = TRUE, balance = balance + 50 WHERE chat_id = $1', [userId]);
            await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'welcome_bonus', 50]);
            const userRes = await pool.query('SELECT referred_by FROM users WHERE chat_id = $1', [userId]);
            const referrer = userRes.rows[0]?.referred_by;
            if (referrer) {
                const rew = parseInt(process.env.REFERRAL_REWARD);
                await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [rew, referrer]);
                await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [referrer, 'referral_bonus', rew]);
            }
            bot.answerCallbackQuery(query.id, { text: "Verified!" });
            return replaceMessage(chatId, userId, "Verified! You received 50 NGN bonus.", mainMenu);
        } else { return bot.answerCallbackQuery(query.id, { text: "Please join group first.", show_alert: true }); }
    }

    if (data.startsWith('approve_') && userId.toString() === process.env.ADMIN_ID) {
        const parts = data.split('_');
        const txId = parts[1];
        const targetUser = parts[2];
        await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
        bot.editMessageText(query.message.text + "\n\nStatus: APPROVED", { chat_id: chatId, message_id: query.message.message_id });
        bot.sendMessage(targetUser, "Your withdrawal request has been approved.").catch(()=>{});
    }
    if (data.startsWith('reject_') && userId.toString() === process.env.ADMIN_ID) {
        const parts = data.split('_');
        const txId = parts[1];
        const targetUser = parts[2];
        const amount = parseInt(parts[3]);
        await pool.query("UPDATE transactions SET status = 'rejected' WHERE id = $1", [txId]);
        await pool.query("UPDATE users SET balance = balance + $1 WHERE chat_id = $2", [amount, targetUser]);
        await pool.query("INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4)", [targetUser, 'refund', amount, 'completed']);
        bot.editMessageText(query.message.text + "\n\nStatus: REJECTED", { chat_id: chatId, message_id: query.message.message_id });
        bot.sendMessage(targetUser, `Withdrawal rejected. Funds refunded.`).catch(()=>{});
    }
});

// --- ADMIN COMMANDS ---
bot.onText(/\/stats/, async (msg) => {
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const res = await pool.query('SELECT COUNT(*) FROM users');
    bot.sendMessage(msg.chat.id, `Total Users: ${res.rows[0].count}`);
});

bot.onText(/\/pending/, async (msg) => {
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    try {
        const res = await pool.query(`SELECT t.id, t.chat_id, t.amount, u.username, u.bank_name, u.account_number FROM transactions t JOIN users u ON t.chat_id = u.chat_id WHERE t.type = 'withdrawal' AND t.status = 'pending' LIMIT 10`);
        if (res.rows.length === 0) return bot.sendMessage(msg.chat.id, "No pending withdrawals.");
        let m = "Pending Withdrawals:\n\n";
        res.rows.forEach(r => { m += `ID: ${r.id} | User: ${r.chat_id}\nAmt: ${r.amount} | /approve ${r.id}\n\n`; });
        bot.sendMessage(msg.chat.id, m);
    } catch (e) { bot.sendMessage(msg.chat.id, "Error fetching pending."); }
});

bot.onText(/\/approve (\d+)/, async (msg, match) => {
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const txId = match[1];
    try {
        const txRes = await pool.query(`SELECT chat_id, status, amount FROM transactions WHERE id = $1 AND type = 'withdrawal'`, [txId]);
        if (txRes.rows.length === 0 || txRes.rows[0].status !== 'pending') return bot.sendMessage(msg.chat.id, "Not found or not pending.");
        await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
        bot.sendMessage(msg.chat.id, `Approved ID: ${txId}`);
        bot.sendMessage(txRes.rows[0].chat_id, "Withdrawal approved.").catch(()=>{});
    } catch (e) { bot.sendMessage(msg.chat.id, "Error."); }
});

bot.onText(/\/add (\d+) (\d+)/, async (msg, match) => {
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const target = match[1]; const amount = parseInt(match[2]);
    try {
        const res = await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2 RETURNING balance', [amount, target]);
        if (res.rows.length > 0) {
            await pool.query('INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4)', [target, 'admin_add', amount, 'completed']);
            bot.sendMessage(msg.chat.id, `Added ${amount} to ${target}. New balance: ${res.rows[0].balance}`);
        } else { bot.sendMessage(msg.chat.id, "User not found."); }
    } catch (err) { bot.sendMessage(msg.chat.id, "Error."); }
});

(async () => {
    await initDB();
    await userBot.connect();
    const dialogs = await userBot.getDialogs();
    for (const dialog of dialogs) {
        if (dialog.title && dialog.title.includes('M4U-Nigeria')) { resolvedGroupEntity = dialog.entity; break; }
    }
    console.log("Bot started.");
})();
