require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { pool, initDB } = require('./db');
const axios = require('axios'); // FIXED: Added missing axios requirement

const port = process.env.PORT || 3000;
const url = process.env.APP_URL;

const bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: { port: port } });

const stringSession = new StringSession(process.env.STRING_SESSION);
const userBot = new TelegramClient(stringSession, parseInt(process.env.API_ID), process.env.API_HASH, {
    connectionRetries: 10,
    useWSS: true
});

const pendingCaptchas = new Map();
const userStates = new Map(); 
let resolvedGroupEntity = null; 

// --- HELPERS ---
async function replaceMessage(chatId, userId, text, options = {}) {
    const state = userStates.get(userId) || {};
    if (state.lastBotMsgId) {
        bot.deleteMessage(chatId, state.lastBotMsgId).catch(() => {});
    }
    const sentMsg = await bot.sendMessage(chatId, text, options);
    state.lastBotMsgId = sentMsg.message_id;
    userStates.set(userId, state);
}

function maskUsername(username) {
    if (!username || username === 'None') return 'Unknown';
    if (username.length <= 4) return username[0] + '***';
    return username.substring(0, 2) + '***' + username.substring(username.length - 2);
}

async function isUserAllowed(userId) {
    const res = await pool.query('SELECT is_banned FROM users WHERE chat_id = $1', [userId]);
    return !(res.rows.length > 0 && res.rows[0].is_banned);
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
        } catch (e) { sendNewNotification(userId, adminId, notificationText, now); }
    } else { sendNewNotification(userId, adminId, notificationText, now); }
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
            if (recentMembers.find(m => m.id.toString() === userId.toString())) return true; 
        } catch (s) {}
        let targetEntity = null;
        if (username && username !== 'None') { try { targetEntity = await userBot.getEntity(username); } catch (err) {} }
        try {
            await userBot.invoke(new Api.channels.GetParticipant({ channel: resolvedGroupEntity, participant: targetEntity ? targetEntity : userId }));
            return true; 
        } catch (apiErr) {
            const errStr = String(apiErr.message || "").toUpperCase();
            if (errStr.includes('USER_NOT_PARTICIPANT') || errStr.includes('PARTICIPANT_ID_INVALID')) return false; 
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

async function processAutoRefunds() {
    try {
        const res = await pool.query(`SELECT id, chat_id, amount FROM transactions WHERE type = 'withdrawal' AND status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'`);
        for (let row of res.rows) {
            await pool.query("UPDATE transactions SET status = 'refunded' WHERE id = $1", [row.id]);
            await pool.query("UPDATE users SET balance = balance + $1 WHERE chat_id = $2", [row.amount, row.chat_id]);
            await pool.query("INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4)", [row.chat_id, 'refund', row.amount, 'completed']);
            bot.sendMessage(row.chat_id, `System Alert: Your withdrawal of ${row.amount.toLocaleString()} NGN has been refunded.`).catch(()=>{});
        }
    } catch (err) { console.log("Auto-refund error:", err.message); }
}

const mainMenu = { reply_markup: { keyboard: [[{ text: 'Task' }, { text: 'Invite Dashboard' }], [{ text: 'Balance' }, { text: 'Top Referrers' }], [{ text: 'Records' }, { text: 'Support' }]], resize_keyboard: true } };
const cancelMenu = { reply_markup: { keyboard: [[{ text: 'Cancel' }]], resize_keyboard: true } };

// --- MESSAGE HANDLER ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;
    if (!text) return;

    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        if (chatId.toString() !== process.env.GROUP_ID) return;
        try {
            const userRes = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
            if (userRes.rows.length === 0 || !userRes.rows[0].is_verified) return;
            const reward = parseInt(process.env.MESSAGE_REWARD) || 3;
            const maxDaily = parseInt(process.env.MAX_DAILY_CHAT) || 100;
            const todayCheck = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE chat_id = $1 AND type = 'chat_reward' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
            const earnedToday = parseInt(todayCheck.rows[0].total);
            if (earnedToday < maxDaily) {
                const toGive = Math.min(reward, maxDaily - earnedToday);
                await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [toGive, userId]);
                await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'chat_reward', toGive]);
            }
        } catch (e) {}
        return; 
    }

    if (msg.chat.type !== 'private') return;
    if (!text.startsWith('/start')) bot.deleteMessage(chatId, msg.message_id).catch(() => {});
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
        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        if (res.rows.length === 0) {
            let finalRef = referredBy !== userId ? referredBy : null;
            if (finalRef) {
                const inGroup = await checkMembership(userId, msg.from.username ? `@${msg.from.username}` : null);
                if (inGroup) finalRef = null;
            }
            await pool.query('INSERT INTO users (chat_id, username, referred_by, is_verified) VALUES ($1, $2, $3, $4)', [userId, msg.from.username ? `@${msg.from.username}` : 'None', finalRef, isAdmin]);
        } else if (res.rows[0].is_verified || isAdmin) {
            await trackUserActivity(msg, "Started Bot");
            bot.sendMessage(chatId, "Welcome back.", mainMenu);
            state.lastBotMsgId = null; userStates.set(userId, state);
            return;
        }
        if (isAdmin) { bot.sendMessage(chatId, "Welcome Admin.", mainMenu); state.lastBotMsgId = null; userStates.set(userId, state); return; }
        const n1 = Math.floor(Math.random() * 10) + 1;
        const n2 = Math.floor(Math.random() * 10) + 1;
        pendingCaptchas.set(userId, { answer: n1 + n2 });
        const cMsg = await bot.sendMessage(chatId, `${n1} + ${n2} = ?`);
        state.lastBotMsgId = cMsg.message_id; userStates.set(userId, state);
        return;
    }

    if (pendingCaptchas.has(userId)) {
        if (parseInt(text) === pendingCaptchas.get(userId).answer) {
            pendingCaptchas.delete(userId);
            return replaceMessage(chatId, userId, "Captcha passed! Join our group to use this bot.", {
                reply_markup: { inline_keyboard: [[{ text: "Join Group", url: "https://t.me/+jgcu6IbmbisxOTM1" }], [{ text: "Join Channel", url: "https://t.me/+Rci2m853ppA0NWY1" }], [{ text: "I have joined", callback_data: "verify_join" }]] }
            });
        } else return replaceMessage(chatId, userId, "Incorrect. Try again or /start.");
    }

    if (state.step) {
        if (state.step === 'AWAITING_ACCOUNT_NAME') {
            state.account_name = text; state.step = 'AWAITING_ACCOUNT_NUMBER'; userStates.set(userId, state);
            return replaceMessage(chatId, userId, "Type your Account Number (10 digits):", cancelMenu);
        }
        if (state.step === 'AWAITING_ACCOUNT_NUMBER') {
            if (!/^\d{10}$/.test(text)) return replaceMessage(chatId, userId, "Invalid. Must be 10 digits:", cancelMenu);
            try {
                await pool.query('UPDATE users SET bank_name = $1, account_name = $2, account_number = $3 WHERE chat_id = $4', [state.bank_name, state.account_name, text, userId]);
                state.step = null; userStates.set(userId, state);
                return replaceMessage(chatId, userId, "Bank info saved.", mainMenu);
            } catch (e) { state.step = null; userStates.set(userId, state); return replaceMessage(chatId, userId, "Error saving details.", mainMenu); }
        }
        if (state.step === 'AWAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = state.user;
            const minW = parseInt(process.env.MIN_WITHDRAW) || 500;
            if (isNaN(amount) || amount < minW) return replaceMessage(chatId, userId, `Min withdrawal is ${minW} NGN.`, cancelMenu);
            if (amount > user.balance) return replaceMessage(chatId, userId, "Insufficient balance.", cancelMenu);
            if (await auditUser(userId)) { state.step = null; userStates.set(userId, state); return; }
            
            let txId; // FIXED: Scoped txId outside the try block
            try {
                await pool.query('UPDATE users SET balance = balance - $1 WHERE chat_id = $2', [amount, userId]);
                const txRes = await pool.query('INSERT INTO transactions (chat_id, type, amount, status) VALUES ($1, $2, $3, $4) RETURNING id', [userId, 'withdrawal', amount, 'pending']);
                txId = txRes.rows[0].id;
                state.step = null; userStates.set(userId, state);
                await replaceMessage(chatId, userId, "Processing...", mainMenu);

                const bankCodes = { 'Opay': '090399', 'Palmpay': '090328', 'Kuda': '090267', 'Moniepoint': '090405' };
                const flwResp = await axios.post('https://api.flutterwave.com/v3/transfers', {
                    account_bank: bankCodes[user.bank_name], account_number: user.account_number, amount: amount, currency: "NGN", reference: `M4U_${txId}_${Date.now()}`
                }, { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}` } });

                if (flwResp.data.status === "success") {
                    await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
                    replaceMessage(chatId, userId, `Success! ${amount} NGN sent to your ${user.bank_name} account.`, mainMenu);
                } else { throw new Error("FLW fail"); }
            } catch (err) {
                replaceMessage(chatId, userId, "Network issue. Forwarded to admin for manual review.", mainMenu);
                if (txId) { // FIXED: Use the scoped txId safely here
                    bot.sendMessage(process.env.ADMIN_ID, `Auto-Payout Failed for User ${userId}\nAmount: ${amount} NGN\nBank: ${user.bank_name}\nAcc: ${user.account_number}\n\nApprove: /approve ${txId}`, {
                        reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `approve_${txId}_${userId}_${amount}` }]] }
                    });
                }
            }
            return;
        }
    }

    if (text === 'Task') {
        const reward = process.env.MESSAGE_REWARD || 3;
        replaceMessage(chatId, userId, `*Task Center*\n\n*1. Daily Sign-in* - /signin\n*2. Chat to Earn*\nEarn ${reward} NGN per message in M4U-Nigeria group!\nMax: 100 NGN daily.`, { parse_mode: 'Markdown', ...mainMenu });
    } else if (text === '/signin') {
        const refToday = await pool.query(`SELECT COUNT(*) FROM users WHERE referred_by = $1 AND is_verified = TRUE AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
        if (parseInt(refToday.rows[0].count) < 1) return replaceMessage(chatId, userId, "Need 1 verified referral today to sign in.", mainMenu);
        const claimed = await pool.query(`SELECT id FROM transactions WHERE chat_id = $1 AND type = 'signin_bonus' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
        if (claimed.rows.length > 0) return replaceMessage(chatId, userId, "Already claimed today.", mainMenu);
        await pool.query('UPDATE users SET balance = balance + 10 WHERE chat_id = $1', [userId]);
        await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'signin_bonus', 10]);
        replaceMessage(chatId, userId, "Sign-in successful!", mainMenu);
    } else if (text === 'Balance') {
        const b = await pool.query('SELECT balance, bank_name, account_number FROM users WHERE chat_id = $1', [userId]);
        const u = b.rows[0];
        replaceMessage(chatId, userId, `Balance: ${u.balance.toLocaleString()} NGN\nBank: ${u.bank_name || 'Not set'} (${u.account_number || 'N/A'})\n\n/withdraw | /setbank`, mainMenu);
    } else if (text === '/setbank') {
        state.step = 'AWAITING_BANK_SELECTION'; userStates.set(userId, state);
        replaceMessage(chatId, userId, "Select your Bank:", { reply_markup: { inline_keyboard: [[{ text: 'Opay', callback_data: 'bank_Opay' }, { text: 'Palmpay', callback_data: 'bank_Palmpay' }], [{ text: 'Kuda', callback_data: 'bank_Kuda' }, { text: 'Moniepoint', callback_data: 'bank_Moniepoint' }], [{ text: 'Cancel', callback_data: 'cancel_op' }]] } });
    } else if (text === '/withdraw') {
        const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
        const user = res.rows[0];
        if (!user.bank_name) return replaceMessage(chatId, userId, "Set bank info first. /setbank", mainMenu);
        const wToday = await pool.query(`SELECT id FROM transactions WHERE chat_id = $1 AND type = 'withdrawal' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')`, [userId]);
        if (wToday.rows.length > 0) return replaceMessage(chatId, userId, "Only one withdrawal per day.", mainMenu);
        state.step = 'AWAITING_WITHDRAW_AMOUNT'; state.user = user; userStates.set(userId, state);
        replaceMessage(chatId, userId, `Withdraw amount (Min: ${process.env.MIN_WITHDRAW || 500}):`, cancelMenu);
    } else if (text === 'Invite Dashboard') {
        bot.getMe().then(async (b) => {
            const res = await pool.query('SELECT username, is_verified FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 5', [userId]);
            replaceMessage(chatId, userId, `Link: https://t.me/${b.username}?start=${userId}\n\nRecent Invites:\n${res.rows.map((r, i) => `${i+1}. ${r.username} - ${r.is_verified?'Verified':'Pending'}`).join('\n') || 'None'}`, mainMenu);
        });
    }
});

// --- CALLBACK HANDLER ---
bot.on('callback_query', async (q) => {
    const userId = q.from.id; const chatId = q.message.chat.id; const data = q.data;
    if (!(await isUserAllowed(userId))) return;

    if (data.startsWith('bank_')) {
        const bank = data.split('_')[1];
        let state = userStates.get(userId) || {};
        state.bank_name = bank; state.step = 'AWAITING_ACCOUNT_NAME'; userStates.set(userId, state);
        bot.answerCallbackQuery(q.id);
        return replaceMessage(chatId, userId, `Bank: ${bank}\nNow type your Account Name:`, cancelMenu);
    }
    if (data === 'cancel_op') {
        let state = userStates.get(userId) || {}; state.step = null; userStates.set(userId, state);
        bot.answerCallbackQuery(q.id); return replaceMessage(chatId, userId, "Cancelled.", mainMenu);
    }
    if (data === 'verify_join') {
        if (await checkMembership(userId, q.from.username)) {
            await pool.query('UPDATE users SET is_verified = TRUE, balance = balance + 50 WHERE chat_id = $1', [userId]);
            await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [userId, 'welcome_bonus', 50]);
            const rRes = await pool.query('SELECT referred_by FROM users WHERE chat_id = $1', [userId]);
            const ref = rRes.rows[0]?.referred_by;
            if (ref) {
                const rew = parseInt(process.env.REFERRAL_REWARD);
                await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [rew, ref]);
                await pool.query('INSERT INTO transactions (chat_id, type, amount) VALUES ($1, $2, $3)', [ref, 'referral_bonus', rew]);
            }
            bot.answerCallbackQuery(q.id, { text: "Verified!" }); return replaceMessage(chatId, userId, "Verified! 50 NGN welcome bonus added.", mainMenu);
        } else bot.answerCallbackQuery(q.id, { text: "Join group first!", show_alert: true });
    }
});

// --- ADMIN & STARTUP ---
bot.onText(/\/approve (\d+)/, async (msg, match) => {
    if (msg.from.id.toString() !== process.env.ADMIN_ID) return;
    const txId = match[1];
    try {
        const res = await pool.query(`SELECT chat_id, status, amount FROM transactions WHERE id = $1 AND type = 'withdrawal' AND status = 'pending'`, [txId]);
        if (res.rows.length === 0) return bot.sendMessage(msg.chat.id, "Pending withdrawal not found.");
        await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [txId]);
        bot.sendMessage(msg.chat.id, `Approved ID ${txId}.`);
        bot.sendMessage(res.rows[0].chat_id, "Withdrawal approved.").catch(()=>{});
    } catch (e) { bot.sendMessage(msg.chat.id, "Error."); }
});

(async () => {
    await initDB();
    if (process.env.ADMIN_ID) await pool.query(`INSERT INTO users (chat_id, username, is_verified) VALUES ($1, 'Admin', TRUE) ON CONFLICT (chat_id) DO UPDATE SET is_verified = TRUE`, [process.env.ADMIN_ID]);
    bot.setWebHook(`${url}/bot${process.env.BOT_TOKEN}`);
    await userBot.connect();
    const dialogs = await userBot.getDialogs();
    for (const d of dialogs) { if (d.title && d.title.includes('M4U-Nigeria')) { resolvedGroupEntity = d.entity; break; } }
    console.log("Bot started.");
})();
