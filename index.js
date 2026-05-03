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
let resolvedGroupEntity = null; // Caches the group data on startup

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

async function checkMembership(userId) {
    try {
        if (!resolvedGroupEntity) {
            console.log("Verification failed: Group entity is missing.");
            return false;
        }

        try {
            await userBot.invoke(new Api.channels.GetParticipant({
                channel: resolvedGroupEntity,
                participant: userId
            }));
            return true; 
            
        } catch (innerErr) {
            if (String(innerErr).includes("Could not find the input entity")) {
                await userBot.invoke(new Api.channels.GetParticipant({
                    channel: resolvedGroupEntity,
                    participant: new Api.InputPeerUser({ userId: BigInt(userId), accessHash: BigInt(0) })
                }));
                return true;
            }
            throw innerErr; 
        }
        
    } catch (e) {
        const errStr = String(e.message || e.className || "").toUpperCase();
        
        // STRICT CHECK: Now includes PARTICIPANT_ID_INVALID
        if (errStr.includes('USER_NOT_PARTICIPANT') || errStr.includes('PARTICIPANT_ID_INVALID')) {
            return false; 
        }

        if (e.code === 420 || errStr.includes('FLOOD')) {
            return true; 
        }

        console.log(`[Safe Fallback for ${userId}]:`, e.message || e.className);
        return true; 
    }
}



async function auditUser(userId) {
    if (userId.toString() === process.env.ADMIN_ID) return false;

    const userRes = await pool.query('SELECT is_verified, balance, referred_by FROM users WHERE chat_id = $1', [userId]);
    
    if (userRes.rows.length > 0 && userRes.rows[0].is_verified) {
        const isStillMember = await checkMembership(userId);
        
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
            [{ text: 'Task' }, { text: 'Invite' }],
            [{ text: 'Balance' }, { text: 'Support' }]
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

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!(await isUserAllowed(userId))) return;

    const payload = match[1]; 
    const referredBy = payload ? parseInt(payload) : null;
    const isAdmin = userId.toString() === process.env.ADMIN_ID;

    userStates.delete(userId); 

    const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
    
    if (res.rows.length === 0) {
        await pool.query(
            'INSERT INTO users (chat_id, username, referred_by, is_verified) VALUES ($1, $2, $3, $4)',
            [userId, msg.from.username, referredBy !== userId ? referredBy : null, isAdmin]
        );
    } else if (res.rows[0].is_verified || isAdmin) {
        await trackUserActivity(msg, "Started Bot");
        return bot.sendMessage(chatId, "Welcome back!", mainMenu);
    }

    if (isAdmin) {
        return bot.sendMessage(chatId, "Welcome Admin. Verification bypassed.", mainMenu);
    }

    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    pendingCaptchas.set(userId, { answer: num1 + num2, referredBy });

    bot.sendMessage(chatId, `To proceed, please solve this simple math problem:\n\n${num1} + ${num2} = ?\n\nReply with the correct number.`, {
        reply_markup: { remove_keyboard: true }
    });
});

bot.onText(/\/records/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!(await isUserAllowed(userId))) return;

    if (await auditUser(userId)) return;
    await trackUserActivity(msg, "Checked Records");

    const res = await pool.query('SELECT type, amount, status, created_at FROM transactions WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]);
    
    if (res.rows.length === 0) {
        return bot.sendMessage(chatId, "No transaction records found.");
    }

    let recordMsg = "Your Last 10 Transactions:\n\n";
    res.rows.forEach(r => {
        const date = new Date(r.created_at).toLocaleString();
        recordMsg += `Type: ${r.type.toUpperCase()}\nAmount: ${r.amount.toLocaleString()} NGN\nStatus: ${r.status.toUpperCase()}\nDate: ${date}\n\n`;
    });

    bot.sendMessage(chatId, recordMsg);
});

bot.onText(/\/setbank/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isAdmin = userId.toString() === process.env.ADMIN_ID;
    if (!(await isUserAllowed(userId))) return;

    if (await auditUser(userId)) return;
    await trackUserActivity(msg, "Setting Bank Info");

    const res = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
    if ((res.rows.length === 0 || !res.rows[0].is_verified) && !isAdmin) {
        return bot.sendMessage(chatId, "You must complete the verification process first.");
    }

    userStates.set(userId, { step: 'AWAITING_BANK_NAME' });
    bot.sendMessage(chatId, "Please enter your Bank Name:", cancelMenu);
});

bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isAdmin = userId.toString() === process.env.ADMIN_ID;
    if (!(await isUserAllowed(userId))) return;

    if (await auditUser(userId)) return;
    await trackUserActivity(msg, "Initiated Withdrawal");

    const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
    if ((res.rows.length === 0 || !res.rows[0].is_verified) && !isAdmin) {
        return bot.sendMessage(chatId, "You must complete the verification process first.");
    }

    const user = res.rows[0];

    if (!user.bank_name || !user.account_name || !user.account_number) {
        return bot.sendMessage(chatId, "You have not set your bank info yet. Please use /setbank first.");
    }

    const minWithdraw = parseInt(process.env.MIN_WITHDRAW) || 500;

    if (user.balance < minWithdraw) {
        return bot.sendMessage(chatId, `Your balance is too low. Minimum withdrawal is ${minWithdraw.toLocaleString()} NGN.`);
    }

    userStates.set(userId, { step: 'AWAITING_WITHDRAW_AMOUNT', user: user });
    bot.sendMessage(chatId, `Enter the amount you want to withdraw (Minimum: ${minWithdraw.toLocaleString()} NGN):`, cancelMenu);
});

bot.onText(/\/audit/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

    bot.sendMessage(chatId, "Starting manual audit of all verified users. This may take a moment...");
    
    try {
        const users = await pool.query('SELECT chat_id FROM users WHERE is_verified = TRUE');
        let penalizedCount = 0;
        
        for (let row of users.rows) {
            const penalized = await auditUser(row.chat_id);
            if (penalized) penalizedCount++;
            await new Promise(r => setTimeout(r, 1000));
        }
        
        bot.sendMessage(chatId, `Audit complete. Found and penalized ${penalizedCount} user(s) who left the group.`);
    } catch (e) {
        bot.sendMessage(chatId, "An error occurred during the audit.");
    }
});

bot.onText(/\/add (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const targetUserId = match[1];
    const amount = parseInt(match[2]);
    try {
        const res = await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2 RETURNING balance', [amount, targetUserId]);
        if (res.rowCount > 0) {
            await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [targetUserId, 'admin_add', amount]);
            bot.sendMessage(chatId, `Successfully added ${amount.toLocaleString()} NGN to user ${targetUserId}. New balance is ${res.rows[0].balance.toLocaleString()} NGN.`);
            bot.sendMessage(targetUserId, `An admin has added ${amount.toLocaleString()} NGN to your balance.`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, "User not found.");
        }
    } catch (err) {}
});

bot.onText(/\/deduct (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const targetUserId = match[1];
    const amount = parseInt(match[2]);
    try {
        const res = await pool.query('UPDATE users SET balance = GREATEST(balance - $1, 0) WHERE chat_id = $2 RETURNING balance', [amount, targetUserId]);
        if (res.rowCount > 0) {
            await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [targetUserId, 'admin_deduct', -amount]);
            bot.sendMessage(chatId, `Successfully deducted ${amount.toLocaleString()} NGN from user ${targetUserId}. New balance is ${res.rows[0].balance.toLocaleString()} NGN.`);
            bot.sendMessage(targetUserId, `An admin has deducted ${amount.toLocaleString()} NGN from your balance.`).catch(()=>{});
        } else {
            bot.sendMessage(chatId, "User not found.");
        }
    } catch (err) {}
});

bot.onText(/\/ban (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const targetUserId = match[1];
    try {
        await pool.query('UPDATE users SET is_banned = TRUE WHERE chat_id = $1', [targetUserId]);
        bot.sendMessage(chatId, `User ${targetUserId} has been banned.`);
    } catch (e) {
        bot.sendMessage(chatId, "Database error while banning.");
    }
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const targetUserId = match[1];
    try {
        await pool.query('UPDATE users SET is_banned = FALSE WHERE chat_id = $1', [targetUserId]);
        bot.sendMessage(chatId, `User ${targetUserId} has been unbanned.`);
    } catch (e) {
        bot.sendMessage(chatId, "Database error while unbanning.");
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;
    if (!(await isUserAllowed(userId))) return;

    if (text === 'Cancel' || text === '/cancel') {
        if (userStates.has(userId)) {
            userStates.delete(userId);
            return bot.sendMessage(chatId, "Operation cancelled.", mainMenu);
        }
    }

    if (text.startsWith('/') && text !== '/setbank' && text !== '/withdraw') {
        userStates.delete(userId);
    }

    if (pendingCaptchas.has(userId) && !text.startsWith('/')) {
        const expected = pendingCaptchas.get(userId).answer;
        if (parseInt(text) === expected) {
            pendingCaptchas.delete(userId);
            return bot.sendMessage(chatId, "Captcha passed!\n\nNow, you must join our group to use this bot.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Join Group", url: "https://t.me/+jgcu6IbmbisxOTM1" }],
                        [{ text: "Join Channel", url: "https://t.me/+Rci2m853ppA0NWY1" }],
                        [{ text: "I have joined", callback_data: "verify_join" }]
                    ]
                }
            });
        } else {
            return bot.sendMessage(chatId, "Incorrect. Try again or send /start to get a new captcha.");
        }
    }

    if (userStates.has(userId) && !text.startsWith('/')) {
        const state = userStates.get(userId);

        if (state.step === 'AWAITING_BANK_NAME') {
            state.bank_name = text;
            state.step = 'AWAITING_ACCOUNT_NAME';
            userStates.set(userId, state);
            return bot.sendMessage(chatId, "Received. Now, please enter your Account Name:", cancelMenu);
        }

        if (state.step === 'AWAITING_ACCOUNT_NAME') {
            state.account_name = text;
            state.step = 'AWAITING_ACCOUNT_NUMBER';
            userStates.set(userId, state);
            return bot.sendMessage(chatId, "Received. Finally, please enter your Account Number:", cancelMenu);
        }

        if (state.step === 'AWAITING_ACCOUNT_NUMBER') {
            try {
                await pool.query(
                    'UPDATE users SET bank_name = $1, account_name = $2, account_number = $3 WHERE chat_id = $4',
                    [state.bank_name, state.account_name, text, userId]
                );
                userStates.delete(userId);
                return bot.sendMessage(chatId, "Your bank information has been successfully saved. You can now use /withdraw.", mainMenu);
            } catch (err) {
                if (err.code === '23505') {
                    userStates.delete(userId);
                    return bot.sendMessage(chatId, "Error: This account number is already registered to another user. Process cancelled. Please use /setbank to try again with a valid account.", mainMenu);
                }
                return bot.sendMessage(chatId, "An error occurred while saving your details. Please try again later.", mainMenu);
            }
        }

        if (state.step === 'AWAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = state.user;
            const minWithdraw = parseInt(process.env.MIN_WITHDRAW) || 500;

            if (isNaN(amount) || amount < minWithdraw) {
                return bot.sendMessage(chatId, `Please enter a valid number that is at least ${minWithdraw.toLocaleString()}.`, cancelMenu);
            }

            if (amount > user.balance) {
                return bot.sendMessage(chatId, `Insufficient balance. Your current balance is ${user.balance.toLocaleString()} NGN.`, cancelMenu);
            }

            try {
                await pool.query('UPDATE users SET balance = balance - $1 WHERE chat_id = $2', [amount, userId]);
                
                const txRes = await pool.query('INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4) RETURNING id', [userId, 'withdrawal', amount, 'pending']);
                const txId = txRes.rows[0].id;
                
                userStates.delete(userId);
                bot.sendMessage(chatId, "Success, waiting for approval...", mainMenu);

                const adminMessage = `New Withdrawal Request:\n\nUser ID: ${userId}\nUsername: @${user.username || 'None'}\nAmount: ${amount.toLocaleString()} NGN\n\nBank Name: ${user.bank_name}\nAccount Name: ${user.account_name}\nAccount Number: ${user.account_number}`;
                
                bot.sendMessage(process.env.ADMIN_ID, adminMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Approve", callback_data: `approve_${txId}_${userId}_${amount}` }],
                            [{ text: "Reject", callback_data: `reject_${txId}_${userId}_${amount}` }]
                        ]
                    }
                });

            } catch (err) {
                bot.sendMessage(chatId, "An error occurred while processing your withdrawal. Please try again later.", mainMenu);
            }
            return;
        }
    }

    const userStatus = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
    const isVerified = userStatus.rows.length > 0 && userStatus.rows[0].is_verified;
    const isAdmin = userId.toString() === process.env.ADMIN_ID;

    if (!isVerified && !isAdmin && !text.startsWith('/')) {
        return bot.sendMessage(chatId, "You must complete the verification process first.", { reply_markup: { remove_keyboard: true }});
    }

    if (text === 'Task') {
        if (await auditUser(userId)) return;
        await trackUserActivity(msg, "Checked Tasks");
        bot.sendMessage(chatId, "No tasks available at the moment. Check back later!");
    } 
    else if (text === 'Invite') {
        if (await auditUser(userId)) return;
        await trackUserActivity(msg, "Clicked Invite");
        bot.getMe().then(botInfo => {
            const inviteLink = `https://t.me/${botInfo.username}?start=${userId}`;
            bot.sendMessage(chatId, `Share this link with your friends to earn ${parseInt(process.env.REFERRAL_REWARD).toLocaleString()} NGN per verified invite!\n\n${inviteLink}`);
        });
    } 
    else if (text === 'Balance') {
        if (await auditUser(userId)) return;
        await trackUserActivity(msg, "Checked Balance");
        const balanceRes = await pool.query('SELECT balance FROM users WHERE chat_id = $1', [userId]);
        const refCount = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by = $1 AND is_verified = TRUE', [userId]);
        
        if (balanceRes.rows.length > 0) {
            bot.sendMessage(chatId, `Your Account\n\nBalance: ${balanceRes.rows[0].balance.toLocaleString()} NGN\nVerified Referrals: ${refCount.rows[0].count}\n\nTo withdraw, use /withdraw`);
        }
    } 
    else if (text === 'Support') {
        await trackUserActivity(msg, "Clicked Support");
        bot.sendMessage(chatId, `For any inquiries, please contact ${process.env.SUPPORT_USERNAME}`);
    }
});

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!(await isUserAllowed(userId))) return;

    if (data === 'verify_join') {
        await trackUserActivity(query.message, "Clicked Verify Join");
        const isMember = await checkMembership(userId);
        
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

            bot.editMessageText("Verification successful! You received a 100 NGN welcome bonus. Welcome to the bot.", {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            bot.sendMessage(chatId, "Select an option from the menu:", mainMenu);
        } else {
            bot.answerCallbackQuery(query.id, { text: "You haven't joined the required group yet. Please join and try again.", show_alert: true });
        }
    }

    if (data.startsWith('approve_') && userId.toString() === process.env.ADMIN_ID) {
        const parts = data.split('_');
        const txId = parts[1];
        const targetUser = parts[2];

        await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
        bot.editMessageText(query.message.text + "\n\nStatus: APPROVED", { chat_id: chatId, message_id: query.message.message_id });
        bot.sendMessage(targetUser, "Your withdrawal request has been approved and processed. Check /records for details.").catch(()=>{});
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
        bot.sendMessage(targetUser, `Your withdrawal request of ${amount.toLocaleString()} NGN was rejected. The funds have been refunded to your bot balance. Check /records for details.`).catch(()=>{});
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
        console.log("WARNING: Could not find M4U-Nigeria in userbot's chat list. Make sure your userbot account is in the group.");
    }

    console.log(`Main bot is running on Webhooks, port: ${port}`);
})();
