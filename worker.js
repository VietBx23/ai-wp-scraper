const db = require('./db');
const Article = require('./article');
const { rewriteAllLanguages } = require('./ai');

const BATCH_SIZE    = parseInt(process.env.WORKER_BATCH_SIZE) || 4;
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_MS)    || 20000;
const MAX_RETRIES   = 3;

let isWorking = false;

// Track số lần thử per article id (in-memory, reset khi restart)
const retryCount = new Map();

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
        try { await conn.rollback(); } catch (_) {}
        throw e;
    } finally {
        try { conn.release(); } catch (_) {}
    }
}

async function processOne(article) {
    const key = article.id;
    const attempts = (retryCount.get(key) || 0) + 1;
    retryCount.set(key, attempts);

    console.log(`[Worker] [${article.language}] attempt ${attempts}/${MAX_RETRIES}: "${article.title_raw?.slice(0, 55)}"`);

    try {
        const results = await rewriteAllLanguages(
            article.content_raw, article.title_raw, article.featured_image,
            [article.language]
        );
        const ai = results[article.language];

        if (!ai) {
            if (attempts < MAX_RETRIES) {
                console.log(`   ⚠️  [${article.language}] AI failed — will retry (${attempts}/${MAX_RETRIES})`);
                // Reset về pending để cycle sau pick lại
                await Article.updateStatus(article.id, 'pending');
            } else {
                console.log(`   ❌ [${article.language}] AI failed after ${MAX_RETRIES} attempts — marking ai_error`);
                await Article.updateStatus(article.id, 'ai_error');
                retryCount.delete(key);
            }
            return;
        }

        await Article.updateAI(article.id, ai, article.title_raw);
        console.log(`   ✅ [${article.language}] ${ai.title.slice(0, 60)}`);
        retryCount.delete(key); // success, clear counter
    } catch (e) {
        console.error(`   ❌ [${article.language}] Error: ${e.message}`);
        if (attempts < MAX_RETRIES) {
            console.log(`   ⚠️  Will retry (${attempts}/${MAX_RETRIES})`);
            await Article.updateStatus(article.id, 'pending');
        } else {
            await Article.updateStatus(article.id, 'ai_error');
            retryCount.delete(key);
        }
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
        if (e.message?.includes('closed state') || e.message?.includes('connection')) {
            console.warn('[Worker] DB connection lost, will retry next cycle.');
        } else {
            console.error('[Worker] Cycle error:', e.message);
        }
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
    console.log(`[Worker] Started — poll every ${POLL_INTERVAL / 1000}s, batch=${BATCH_SIZE}, max retries=${MAX_RETRIES}`);
    resetStuck();
    runCycle();
    setInterval(runCycle, POLL_INTERVAL);
    setInterval(resetStuck, 30 * 60 * 1000);
}

module.exports = { startWorker };
