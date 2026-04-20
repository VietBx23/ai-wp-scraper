const db = require('./db');
const Article = require('./article');
const { rewriteAllLanguages, classifyArticle } = require('./ai');

const BATCH_SIZE    = parseInt(process.env.WORKER_BATCH_SIZE) || 4;
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_MS)    || 20000;
const MAX_RETRIES   = 3;

let isWorking = false;
const retryCount = new Map();

// Cache classification theo origin_id — 1 bài gốc = 1 topic/type cho tất cả ngôn ngữ
const _classifyCache = new Map();

async function getClassification(originId, contentRaw, titleRaw, topics, siteTypes) {
    if (_classifyCache.has(originId)) return _classifyCache.get(originId);

    const result = await classifyArticle(contentRaw, titleRaw, topics, siteTypes);

    let topic_id = null, site_type_id = null;
    if (result?.topic) {
        const t = topics.find(t => t.name.toLowerCase() === result.topic.toLowerCase().trim());
        if (t) topic_id = t.id;
        else console.warn(`   ⚠️ Topic "${result.topic}" not in DB`);
    }
    if (result?.site_type) {
        const st = siteTypes.find(s => s.name.toLowerCase() === result.site_type.toLowerCase().trim());
        if (st) site_type_id = st.id;
        else console.warn(`   ⚠️ SiteType "${result.site_type}" not in DB`);
    }

    const classification = { topic_id, site_type_id };
    _classifyCache.set(originId, classification);
    setTimeout(() => _classifyCache.delete(originId), 60 * 60 * 1000);
    console.log(`   🏷️  [Classify] topic_id=${topic_id} site_type_id=${site_type_id}`);
    return classification;
}

// Cache topics và site_types từ DB, refresh mỗi 15 phút
let _metaCache = null;
async function getMeta() {
    if (_metaCache) return _metaCache;
    const [topics]    = await db.query(`SELECT id, name FROM topics WHERE is_active = 1`);
    const [siteTypes] = await db.query(`SELECT id, name FROM site_types WHERE is_active = 1`);
    _metaCache = { topics, siteTypes };
    setTimeout(() => { _metaCache = null; }, 15 * 60 * 1000);
    return _metaCache;
}

async function getInterlink(topic_id, language) {
    try {
        const [rows] = await db.query(
            `SELECT li.url, li.anchor_text
             FROM link_inventory li
             JOIN websites w ON w.id = li.website_id
             LEFT JOIN website_topics wt ON wt.website_id = w.id
             WHERE li.is_active = 1
               AND w.level = 3
               AND w.status = 'active'
               AND w.language = ?
               ${topic_id ? 'AND (wt.topic_id = ? OR wt.topic_id IS NULL)' : ''}
             ORDER BY RAND()
             LIMIT 1`,
            topic_id ? [language, topic_id] : [language]
        );
        return rows[0] || null;
    } catch (e) {
        console.warn(`   [Backlink] getInterlink error: ${e.message}`);
        return null;
    }
}

// Inject backlink vào giữa bài — sau thẻ </p> thứ 3 để tự nhiên hơn
function injectBacklink(content, link) {
    if (!link || !link.url || !link.anchor_text) return content;
    const html = `\n<p><a href="${link.url}" title="${link.anchor_text}" rel="dofollow">${link.anchor_text}</a></p>`;

    // Tìm vị trí sau </p> thứ 3
    let count = 0, pos = -1, idx = 0;
    while (count < 3) {
        idx = content.indexOf('</p>', idx);
        if (idx === -1) break;
        pos = idx + 4; // sau </p>
        count++;
        idx = pos;
    }

    if (pos !== -1) {
        return content.slice(0, pos) + html + content.slice(pos);
    }
    // fallback: append trước </article> hoặc cuối
    if (content.includes('</article>')) return content.replace('</article>', html + '</article>');
    return content + html;
}

async function claimBatch() {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // Lấy BATCH_SIZE origin_id distinct có bài pending — đảm bảo group đủ 4 ngôn ngữ
        const [originRows] = await conn.query(
            `SELECT origin_id FROM articles
             WHERE status = 'pending'
             GROUP BY origin_id
             ORDER BY MIN(created_at) ASC
             LIMIT ?`,
            [BATCH_SIZE]
        );
        if (!originRows.length) { await conn.commit(); return []; }

        const originIds = originRows.map(r => r.origin_id);

        // Lấy TẤT CẢ bài của các origin_id đó (tức là tất cả ngôn ngữ)
        const placeholders = originIds.map(() => '?').join(',');
        const [rows] = await conn.query(
            `SELECT id, origin_id, language, title_raw, content_raw, featured_image, topic_id, site_type_id, category
             FROM articles
             WHERE status = 'pending' AND origin_id IN (${placeholders})
             FOR UPDATE SKIP LOCKED`,
            originIds
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

async function processOne(article, sharedClassification) {
    const key = article.id;
    const attempts = (retryCount.get(key) || 0) + 1;
    retryCount.set(key, attempts);
    console.log(`[Worker] [${article.language}] attempt ${attempts}/${MAX_RETRIES}: "${article.title_raw?.slice(0, 55)}"`);

    try {
        const { topic_id, site_type_id } = sharedClassification;

        // Fetch interlink trước để AI tự chèn vào bài một cách tự nhiên
        const interlink = await getInterlink(topic_id, article.language);
        if (interlink) {
            console.log(`   🔗 [Backlink] Will embed: ${interlink.url} | "${interlink.anchor_text}"`);
        } else {
            console.warn(`   ⚠️ [Backlink] No interlink found for topic_id=${topic_id} lang=${article.language}`);
        }

        // Rewrite content — AI tự chèn interlink vào bài
        const result = await rewriteAllLanguages(
            article.content_raw, article.title_raw, article.featured_image,
            [article.language], interlink
        );
        const ai = result.articles[article.language];

        if (!ai) {
            if (attempts < MAX_RETRIES) {
                await Article.updateStatus(article.id, 'pending');
            } else {
                await Article.updateStatus(article.id, 'ai_error');
                retryCount.delete(key);
            }
            return;
        }

        // Kiểm tra độ dài content — nếu quá ngắn thì retry để AI gen lại
        const plainLength = ai.content?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length || 0;
        const MIN_CONTENT_LENGTH = parseInt(process.env.MIN_CONTENT_LENGTH) || 600;
        if (plainLength < MIN_CONTENT_LENGTH) {
            console.warn(`   ⚠️ [${article.language}] Content too short (${plainLength} chars < ${MIN_CONTENT_LENGTH}) — retry`);
            if (attempts < MAX_RETRIES) {
                await Article.updateStatus(article.id, 'pending');
            } else {
                console.error(`   ❌ [${article.language}] Still too short after ${MAX_RETRIES} attempts — marking ai_error`);
                await Article.updateStatus(article.id, 'ai_error');
                retryCount.delete(key);
            }
            return;
        }

        await Article.updateAI(article.id, ai, article.title_raw, topic_id, site_type_id);
        console.log(`   ✅ [${article.language}] topic_id=${topic_id} site_type_id=${site_type_id} | ${ai.title.slice(0, 60)}`);
        retryCount.delete(key);
    } catch (e) {
        console.error(`   ❌ [${article.language}] Error: ${e.message}`);
        if (attempts < MAX_RETRIES) {
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

        // Group theo origin_id — đảm bảo 4 ngôn ngữ cùng origin dùng chung 1 classification
        const groups = new Map();
        for (const job of jobs) {
            if (!groups.has(job.origin_id)) groups.set(job.origin_id, []);
            groups.get(job.origin_id).push(job);
        }

        console.log(`\n[Worker] Processing ${jobs.length} articles across ${groups.size} origin(s)...`);

        const { topics, siteTypes } = await getMeta();

        for (const [originId, articles] of groups) {
            // Classify 1 lần duy nhất cho cả nhóm
            const rep = articles[0]; // đại diện để classify (dùng content_raw English nếu có)
            const engRep = articles.find(a => a.language === 'English') || rep;

            let topic_id     = engRep.topic_id     || null;
            let site_type_id = engRep.site_type_id || null;

            if (!topic_id || !site_type_id) {
                const cls = await getClassification(originId, engRep.content_raw, engRep.title_raw, topics, siteTypes);
                if (!topic_id)     topic_id     = cls.topic_id;
                if (!site_type_id) site_type_id = cls.site_type_id;
            }

            if (!topic_id || !site_type_id) {
                console.warn(`   ⚠️ [origin=${originId}] Could not classify — skipping ${articles.length} articles`);
                for (const a of articles) await Article.updateStatus(a.id, 'pending');
                continue;
            }

            console.log(`   🏷️  [origin=${originId}] topic_id=${topic_id} site_type_id=${site_type_id} → ${articles.length} lang(s)`);

            // Sync classification vào DB cho TẤT CẢ bài trong nhóm ngay lập tức
            // Đảm bảo 4 ngôn ngữ luôn có cùng topic_id và site_type_id
            const ids = articles.map(a => a.id);
            await db.query(
                `UPDATE articles SET topic_id = ?, site_type_id = ?
                 WHERE id IN (${ids.map(() => '?').join(',')})`,
                [topic_id, site_type_id, ...ids]
            );

            const sharedClassification = { topic_id, site_type_id };

            // Process từng ngôn ngữ trong nhóm với cùng classification
            for (const article of articles) {
                await processOne(article, sharedClassification);
                await new Promise(r => setTimeout(r, 2000));
            }
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
