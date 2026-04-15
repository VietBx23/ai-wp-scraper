
const db = require('./db');

async function ensureTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS crawl_queue (
            id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            source        VARCHAR(50)  NOT NULL,
            origin_id     VARCHAR(500) NOT NULL,
            source_url    VARCHAR(1000),
            title_raw     TEXT,
            content_raw   LONGTEXT,
            featured_image VARCHAR(1000),
            author        VARCHAR(255),
            category      VARCHAR(255) DEFAULT 'Cricket News',
            post_date     DATETIME,
            status        ENUM('pending','processing','done','failed') DEFAULT 'pending',
            attempts      TINYINT UNSIGNED DEFAULT 0,
            error_msg     TEXT,
            created_at    DATETIME DEFAULT NOW(),
            updated_at    DATETIME DEFAULT NOW() ON UPDATE NOW(),
            UNIQUE KEY uq_origin (origin_id(200)),
            INDEX idx_status (status),
            INDEX idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

/**
 * Push một raw article vào queue.
 * Nếu origin_id đã tồn tại → bỏ qua (INSERT IGNORE).
 * @returns {boolean} true nếu thêm mới, false nếu đã tồn tại
 */
async function push(job) {
    const [result] = await db.query(
        `INSERT IGNORE INTO crawl_queue
         (source, origin_id, source_url, title_raw, content_raw, featured_image, author, category, post_date)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
            job.source,
            String(job.origin_id).slice(0, 499),
            job.source_url || null,
            job.title_raw || null,
            job.content_raw || null,
            job.featured_image || null,
            job.author || 'Admin',
            job.category || 'Cricket News',
            job.post_date ? new Date(job.post_date) : new Date(),
        ]
    );
    return result.affectedRows > 0;
}

/**
 * Lấy một batch jobs pending để xử lý.
 * Dùng SELECT ... FOR UPDATE SKIP LOCKED để tránh race condition khi chạy nhiều worker.
 */
async function claimBatch(limit = 5) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT * FROM crawl_queue
             WHERE status = 'pending' AND attempts < 3
             ORDER BY created_at ASC
             LIMIT ?
             FOR UPDATE SKIP LOCKED`,
            [limit]
        );
        if (rows.length) {
            const ids = rows.map(r => r.id);
            await conn.query(
                `UPDATE crawl_queue SET status = 'processing', attempts = attempts + 1
                 WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
        }
        await conn.commit();
        return rows;
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

async function markDone(id) {
    await db.query(`UPDATE crawl_queue SET status = 'done' WHERE id = ?`, [id]);
}

async function markFailed(id, errorMsg) {
    await db.query(
        `UPDATE crawl_queue SET status = 'failed', error_msg = ? WHERE id = ?`,
        [String(errorMsg).slice(0, 500), id]
    );
}

/** Reset jobs bị stuck ở processing quá 30 phút */
async function resetStuck() {
    const [result] = await db.query(
        `UPDATE crawl_queue SET status = 'pending'
         WHERE status = 'processing' AND updated_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`
    );
    if (result.affectedRows > 0)
        console.log(`[Queue] Reset ${result.affectedRows} stuck jobs.`);
}

async function stats() {
    const [[row]] = await db.query(
        `SELECT
            SUM(status='pending')    AS pending,
            SUM(status='processing') AS processing,
            SUM(status='done')       AS done,
            SUM(status='failed')     AS failed
         FROM crawl_queue`
    );
    return row;
}

module.exports = { ensureTable, push, claimBatch, markDone, markFailed, resetStuck, stats };
