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

// State Management
const pendingCaptchas = new Map();
const userStates = new Map(); // Tracks multi-step conversations

async function checkMembership(userId) {
    try {
        // Only checking Group membership now as Channel is optional
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

// Start Command
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const payload = match[1]; 
    const referredBy = payload ? parseInt(payload) : null;

    userStates.delete(userId); // Clear any pending states

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

// Set Bank Command
bot.onText(/\/setbank/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const res = await pool.query('SELECT is_verified FROM users WHERE chat_id = $1', [userId]);
    if (res.rows.length === 0 || !res.rows[0].is_verified) {
        return bot.sendMessage(chatId, "You must complete the verification process first.");
    }

    userStates.set(userId, { step: 'AWAITING_BANK_NAME' });
    bot.sendMessage(chatId, "Please enter your Bank Name:");
});

// Withdraw Command
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const res = await pool.query('SELECT * FROM users WHERE chat_id = $1', [userId]);
    if (res.rows.length === 0 || !res.rows[0].is_verified) {
        return bot.sendMessage(chatId, "You must complete the verification process first.");
    }

    const user = res.rows[0];

    if (!user.bank_name || !user.account_name || !user.account_number) {
        return bot.sendMessage(chatId, "You have not set your bank info yet. Please use /setbank first.");
    }

    if (user.balance < process.env.MIN_WITHDRAW) {
        return bot.sendMessage(chatId, `Your balance is too low. Minimum withdrawal is ${process.env.MIN_WITHDRAW} NGN.`);
    }

    userStates.set(userId, { step: 'AWAITING_WITHDRAW_AMOUNT', user: user });
    bot.sendMessage(chatId, `Enter the amount you want to withdraw (Minimum: ${process.env.MIN_WITHDRAW}):`);
});

// Admin Command: Add Balance
bot.onText(/\/add (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();

    if (adminId !== process.env.ADMIN_ID) {
        return bot.sendMessage(chatId, "Unauthorized action.");
    }

    const targetUserId = match[1];
    const amount = parseInt(match[2]);

    try {
        const res = await pool.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2 RETURNING balance', [amount, targetUserId]);
        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, "User not found in database.");
        }
        bot.sendMessage(chatId, `Successfully added ${amount} to user ${targetUserId}. Their new balance is ${res.rows[0].balance}.`);
        try {
            await bot.sendMessage(targetUserId, `An admin has added ${amount} to your balance.`);
        } catch (e) {} // Ignore if user blocked bot
    } catch (err) {
        bot.sendMessage(chatId, "An error occurred while updating the database.");
    }
});

// Admin Command: Deduct Balance
bot.onText(/\/deduct (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();

    if (adminId !== process.env.ADMIN_ID) {
        return bot.sendMessage(chatId, "Unauthorized action.");
    }

    const targetUserId = match[1];
    const amount = parseInt(match[2]);

    try {
        // Uses GREATEST to ensure balance doesn't drop below 0
        const res = await pool.query('UPDATE users SET balance = GREATEST(balance - $1, 0) WHERE chat_id = $2 RETURNING balance', [amount, targetUserId]);
        if (res.rowCount === 0) {
            return bot.sendMessage(chatId, "User not found in database.");
        }
        bot.sendMessage(chatId, `Successfully deducted ${amount} from user ${targetUserId}. Their new balance is ${res.rows[0].balance}.`);
        try {
            await bot.sendMessage(targetUserId, `An admin has deducted ${amount} from your balance.`);
        } catch (e) {}
    } catch (err) {
        bot.sendMessage(chatId, "An error occurred while updating the database.");
    }
});

// Handle text messages and multi-step states
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (!text) return;

    // Clear state if user starts a new command (ignores admin commands here)
    if (text.startsWith('/') && text !== '/setbank' && text !== '/withdraw') {
        userStates.delete(userId);
    }

    // 1. Handle Captchas
    if (pendingCaptchas.has(userId)) {
        if (text.startsWith('/')) return; // Ignore commands while doing captcha
        
        const expected = pendingCaptchas.get(userId).answer;
        if (parseInt(text) === expected) {
            pendingCaptchas.delete(userId);
            
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Join Group (Required)", url: "https://t.me/+jgcu6IbmbisxOTM1" }],
                        [{ text: "Join Channel (Optional)", url: "https://t.me/+Rci2m853ppA0NWY1" }],
                        [{ text: "I have joined", callback_data: "verify_join" }]
                    ]
                }
            };
            return bot.sendMessage(chatId, "Captcha passed!\n\nNow, you MUST join our group to use this bot. The channel is optional.", options);
        } else {
            return bot.sendMessage(chatId, "Incorrect. Try again or send /start to get a new captcha.");
        }
    }

    // 2. Handle Multi-step States (Bank Info & Withdrawals)
    if (userStates.has(userId) && !text.startsWith('/')) {
        const state = userStates.get(userId);

        if (state.step === 'AWAITING_BANK_NAME') {
            state.bank_name = text;
            state.step = 'AWAITING_ACCOUNT_NAME';
            userStates.set(userId, state);
            return bot.sendMessage(chatId, "Received. Now, please enter your Account Name:");
        }

        if (state.step === 'AWAITING_ACCOUNT_NAME') {
            state.account_name = text;
            state.step = 'AWAITING_ACCOUNT_NUMBER';
            userStates.set(userId, state);
            return bot.sendMessage(chatId, "Received. Finally, please enter your Account Number:");
        }

        if (state.step === 'AWAITING_ACCOUNT_NUMBER') {
            const accountNumber = text;
            try {
                await pool.query(
                    'UPDATE users SET bank_name = $1, account_name = $2, account_number = $3 WHERE chat_id = $4',
                    [state.bank_name, state.account_name, accountNumber, userId]
                );
                userStates.delete(userId);
                return bot.sendMessage(chatId, "Your bank information has been successfully saved. You can now use /withdraw.");
            } catch (err) {
                if (err.code === '23505') {
                    userStates.delete(userId);
                    return bot.sendMessage(chatId, "Error: This account number is already registered to another user. Process cancelled. Please use /setbank to try again with a valid account.");
                }
                return bot.sendMessage(chatId, "An error occurred while saving your details. Please try again later.");
            }
        }

        if (state.step === 'AWAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = state.user;
            const minWithdraw = parseInt(process.env.MIN_WITHDRAW);

            if (isNaN(amount) || amount < minWithdraw) {
                return bot.sendMessage(chatId, `Please enter a valid number that is at least ${minWithdraw}.`);
            }

            if (amount > user.balance) {
                return bot.sendMessage(chatId, `Insufficient balance. Your current balance is ${user.balance}.`);
            }

            try {
                await pool.query('UPDATE users SET balance = balance - $1 WHERE chat_id = $2', [amount, userId]);
                userStates.delete(userId);
                bot.sendMessage(chatId, "Success, waiting for approval...");

                const adminMessage = `New Withdrawal Request:\n\nUser ID: ${userId}\nUsername: @${user.username || 'None'}\nAmount: ${amount} NGN\n\nBank Name: ${user.bank_name}\nAccount Name: ${user.account_name}\nAccount Number: ${user.account_number}`;
                bot.sendMessage(process.env.ADMIN_ID, adminMessage);

            } catch (err) {
                bot.sendMessage(chatId, "An error occurred while processing your withdrawal. Please try again later.");
            }
            return;
        }
    }

    // 3. Handle Main Menu Buttons
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
        
        if (balanceRes.rows.length > 0) {
            bot.sendMessage(chatId, `Your Account\n\nBalance: ${balanceRes.rows[0].balance}\nVerified Referrals: ${refCount.rows[0].count}`);
        }
    } 
    else if (text === 'Support') {
        bot.sendMessage(chatId, `For any inquiries, please contact ${process.env.SUPPORT_USERNAME}`);
    }
});

// Verification Callback
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
                    await bot.sendMessage(referrer, `Your referral has been verified! You earned ${process.env.REFERRAL_REWARD}.`);
                } catch (e) {
                }
            }

            bot.sendMessage(chatId, "Verification successful! Welcome to the bot.", mainMenu);
        } else {
            bot.sendMessage(chatId, "You haven't joined the required group yet. Please join and try again.");
        }
    }
});

// Penalty System
bot.on('chat_member', async (msg) => {
    const memberStatus = msg.new_chat_member.status;
    const chatId = msg.chat.id.toString();
    const userId = msg.new_chat_member.user.id;

    if ((chatId === process.env.GROUP_ID) && 
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
