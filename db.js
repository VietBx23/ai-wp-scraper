require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host:               process.env.MYSQL_HOST,
    port:               parseInt(process.env.MYSQL_PORT) || 3306,
    user:               process.env.MYSQL_USER,
    password:           process.env.MYSQL_PASSWORD,
    database:           process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit:    5,
    charset:            'utf8mb4',
    timezone:           '+00:00',
});

pool.getConnection()
    .then(conn => { console.log('✅ [Crawler] MySQL connected'); conn.release(); })
    .catch(err => { console.error('❌ [Crawler] MySQL failed:', err.message); });

module.exports = pool;
