require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { pool, initDB } = require('./db');

// --- Webhook Configuration ---
const port = process.env.PORT || 3000;
const url = process.env.APP_URL;

const bot = new TelegramBot(process.env.BOT_TOKEN, { 
    webHook: {
        port: port
    } 
});

bot.setWebHook(`${url}/bot${process.env.BOT_TOKEN}`, {
    allowed_updates: ['message', 'callback_query', 'chat_member']
});
// -----------------------------

const stringSession = new StringSession(process.env.STRING_SESSION);
const userBot = new TelegramClient(stringSession, parseInt(process.env.API_ID), process.env.API_HASH, {
    connectionRetries: 10,
    useWSS: true
});

const pendingCaptchas = new Map();

async function checkMembership(userId) {
    try {
        await userBot.invoke(new Api.channels.GetParticipant({
            channel: process.env.CHANNEL_ID,
            participant: userId
        }));
        await userBot.invoke(new Api.channels.GetParticipant({
            channel: process.env.GROUP_ID,
            participant: userId
        }));
        return true;
    } catch (e) {
        return false; 
    }
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

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const payload = match[1]; 
    const referredBy = payload ? parseInt(payload) : null;

    const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
    
    if (res.rows.length === 0) {
        await pool.query(
            'INSERT INTO users (chat_id, username, referred_by) VALUES ($1, $2, $3)',
            [userId, msg.from.username, referredBy !== userId ? referredBy : null]
        );
    } else if (res.rows[0].is_verified) {
        return bot.sendMessage(chatId, "Welcome back!", mainMenu);
    }

    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    pendingCaptchas.set(userId, { answer: num1 + num2, referredBy });

    bot.sendMessage(chatId, `To proceed, please solve this simple math problem:\n\n${num1} + ${num2} = ?\n\nReply with the correct number.`);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    if (pendingCaptchas.has(userId)) {
        const expected = pendingCaptchas.get(userId).answer;
        if (parseInt(text) === expected) {
            pendingCaptchas.delete(userId);
            
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Join Channel", url: "https://t.me/your_channel_link" }],
                        [{ text: "Join Group", url: "https://t.me/your_group_link" }],
                        [{ text: "I have joined", callback_data: "verify_join" }]
                    ]
                }
            };
            return bot.sendMessage(chatId, "Captcha passed!\n\nNow, you MUST join our channels to use this bot.", options);
        } else {
            return bot.sendMessage(chatId, "Incorrect. Try again or send /start to get a new captcha.");
        }
    }

    const res = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
    if (res.rows.length === 0 || !res.rows[0].is_verified) {
        return bot.sendMessage(chatId, "You must complete the /start verification process to use this bot.");
    }

    if (text === 'Task') {
        bot.sendMessage(chatId, "No tasks available at the moment. Check back later!");
    } 
    else if (text === 'Invite') {
        bot.getMe().then(botInfo => {
            const inviteLink = `https://t.me/${botInfo.username}?start=${userId}`;
            bot.sendMessage(chatId, `Share this link with your friends to earn ${process.env.REFERRAL_REWARD} per verified invite!\n\n${inviteLink}`);
        });
    } 
    else if (text === 'Balance') {
        const balanceRes = await pool.query('SELECT balance FROM users WHERE chat_id = $1', [userId]);
        const refCount = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by = $1 AND is_verified = TRUE', [userId]);
        
        bot.sendMessage(chatId, `Your Account\n\nBalance: ${balanceRes.rows[0].balance}\nVerified Referrals: ${refCount.rows[0].count}`);
    } 
    else if (text === 'Support') {
        bot.sendMessage(chatId, `For any inquiries, please contact ${process.env.SUPPORT_USERNAME}`);
    }
});

bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const chatId = query.message.chat.id;

    if (query.data === 'verify_join') {
        bot.answerCallbackQuery(query.id, { text: "Verifying with userbot..." });

        const isMember = await checkMembership(userId);
        
        if (isMember) {
            await pool.query('UPDATE users SET is_verified = TRUE WHERE chat_id = $1', [userId]);
            
            const userRes = await pool.query('SELECT referred_by FROM users WHERE chat_id = $1', [userId]);
            const referrer = userRes.rows[0]?.referred_by;
            
            if (referrer) {
                await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [process.env.REFERRAL_REWARD, referrer]);
                try {
                    await bot.sendMessage(referrer, `Someone joined using your link! You received ${process.env.REFERRAL_REWARD}.`);
                } catch (e) {
                }
            }

            bot.sendMessage(chatId, "Verification successful! Welcome to the bot.", mainMenu);
        } else {
            bot.sendMessage(chatId, "You haven't joined both the channel and the group yet. Please join and try again.");
        }
    }
});

bot.on('chat_member', async (msg) => {
    const memberStatus = msg.new_chat_member.status;
    const chatId = msg.chat.id.toString();
    const userId = msg.new_chat_member.user.id;

    if ((chatId === process.env.CHANNEL_ID || chatId === process.env.GROUP_ID) && 
        (memberStatus === 'left' || memberStatus === 'kicked')) {
        
        const userRes = await pool.query('SELECT referred_by FROM users WHERE chat_id = $1', [userId]);
        if (userRes.rows.length > 0) {
            const referrer = userRes.rows[0].referred_by;
            
            await pool.query('UPDATE users SET balance = 0, is_verified = FALSE WHERE chat_id = $1', [userId]);
            
            if (referrer) {
                await pool.query('UPDATE users SET balance = balance - 50 WHERE chat_id = $1', [referrer]);
                try {
                    await bot.sendMessage(referrer, "One of your referrals left the group. 50 was deducted from your balance.");
                } catch (e) {
                }
            }
        }
    }
});

(async () => {
    await initDB();
    console.log("Connecting UserBot...");
    await userBot.connect();
    console.log("UserBot connected.");
    console.log(`Main bot is running on Webhooks, port: ${port}`);
})();
