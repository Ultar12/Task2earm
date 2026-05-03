const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const initDB = async () => {
    const queryText = `
        CREATE TABLE IF NOT EXISTS users (
            chat_id BIGINT PRIMARY KEY,
            username VARCHAR(255),
            balance INTEGER DEFAULT 0,
            referred_by BIGINT,
            is_verified BOOLEAN DEFAULT FALSE
        );
    `;
    await pool.query(queryText);
    console.log("Database initialized.");
};

module.exports = { pool, initDB };

