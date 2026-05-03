const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const safeAddColumn = async (table, column, definition) => {
    try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    } catch (e) {
        // Column already exists, ignore
    }
};

const initDB = async () => {
    // 1. Users Table
    const createUsers = `
        CREATE TABLE IF NOT EXISTS users (
            chat_id BIGINT PRIMARY KEY,
            username VARCHAR(255),
            balance INTEGER DEFAULT 0,
            referred_by BIGINT,
            is_verified BOOLEAN DEFAULT FALSE
        );
    `;
    await pool.query(createUsers);

    // Force add missing columns
    await safeAddColumn('users', 'bank_name', 'VARCHAR(255)');
    await safeAddColumn('users', 'account_name', 'VARCHAR(255)');
    await safeAddColumn('users', 'account_number', 'VARCHAR(255) UNIQUE');
    await safeAddColumn('users', 'is_banned', 'BOOLEAN DEFAULT FALSE');
    await safeAddColumn('users', 'last_admin_msg_id', 'INTEGER');
    await safeAddColumn('users', 'last_active_time', 'BIGINT');

    // 2. Transactions Table
    const createTransactions = `
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            chat_id BIGINT,
            type VARCHAR(50),
            amount INTEGER,
            status VARCHAR(20) DEFAULT 'completed',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    await pool.query(createTransactions);

    console.log("Database initialized and updated.");
};

module.exports = { pool, initDB };
