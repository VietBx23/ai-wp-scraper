const db = require('./db');
const Article = require('./article');
const { rewriteAllLanguages } = require('./ai');

const BATCH_SIZE    = parseInt(process.env.WORKER_BATCH_SIZE) || 4;
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_MS)    || 20000;

let isWorking = false;

async function claimBatch() {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT id, origin_id, language, title_raw, content_raw, featured_image
             FROM articles WHERE status = 'pending'
             ORDER BY created_at ASC LIMIT ?
             FOR UPDATE SKIP LOCKED`,
            [BATCH_SIZE]
        );
        if (rows.length) {
            const ids = rows.map(r => r.id);
            await conn.query(
                `UPDATE articles SET status = 'processing' WHERE id IN (${ids.map(() => '?').join(',')})`,
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

async function processOne(article) {
    console.log(`[Worker] [${article.language}] "${article.title_raw?.slice(0, 60)}"`);
    try {
        const results = await rewriteAllLanguages(
            article.content_raw, article.title_raw, article.featured_image,
            [article.language]
        );
        const ai = results[article.language];
        if (!ai) {
            console.log(`   ❌ [${article.language}] AI failed`);
            await Article.updateStatus(article.id, 'ai_error');
            return;
        }
        await Article.updateAI(article.id, ai);
        console.log(`   ✅ [${article.language}] ${ai.title.slice(0, 60)}`);
    } catch (e) {
        console.error(`   ❌ [${article.language}] Error: ${e.message}`);
        await Article.updateStatus(article.id, 'ai_error');
    }
}

async function runCycle() {
    if (isWorking) return;
    isWorking = true;
    try {
        const jobs = await claimBatch();
        if (!jobs.length) return;
        console.log(`\n[Worker] Processing ${jobs.length} pending articles...`);
        for (const job of jobs) {
            await processOne(job);
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e) {
        console.error('[Worker] Cycle error:', e.message);
    } finally {
        isWorking = false;
    }
}

async function resetStuck() {
    const [r] = await db.query(
        `UPDATE articles SET status = 'pending'
         WHERE status = 'processing' AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`
    );
    if (r.affectedRows > 0) console.log(`[Worker] Reset ${r.affectedRows} stuck articles.`);
}

function startWorker() {
    console.log(`[Worker] Started — poll every ${POLL_INTERVAL / 1000}s, batch=${BATCH_SIZE}`);
    resetStuck();
    runCycle();
    setInterval(runCycle, POLL_INTERVAL);
    setInterval(resetStuck, 30 * 60 * 1000);
}

module.exports = { startWorker };
