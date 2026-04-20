require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host:               process.env.MYSQL_HOST,
    port:               parseInt(process.env.MYSQL_PORT) || 3306,
    user:               process.env.MYSQL_USER,
    password:           process.env.MYSQL_PASSWORD,
    database:           process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit:    20,
    queueLimit:         100,
    connectTimeout:     15000,
    charset:            'utf8mb4',
    timezone:           '+00:00',
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30000,
});

pool.getConnection()
    .then(conn => { console.log('✅ [Scraper] MySQL connected'); conn.release(); })
    .catch(err => { console.error('❌ [Scraper] MySQL failed:', err.message); process.exit(1); });

module.exports = pool;
