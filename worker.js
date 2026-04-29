const db = require('./db');
const Article = require('./article');
const { rewriteAllLanguages, classifyArticle } = require('./ai');

const BATCH_SIZE    = parseInt(process.env.WORKER_BATCH_SIZE) || 2; // Giảm từ 4 → 2 để tránh rate limit
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_MS)    || 30000; // Tăng từ 20s → 30s
const MAX_RETRIES   = 3;
const DELAY_BETWEEN_ARTICLES = 5000; // 5s delay giữa các bài

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
    const [topics]    = await db.query(`SELECT DISTINCT id, name FROM site_tags WHERE is_active = 1`);
    const [siteTypes] = await db.query(`SELECT DISTINCT id, name FROM site_types WHERE is_active = 1`);
    _metaCache = { topics, siteTypes };
    setTimeout(() => { _metaCache = null; }, 15 * 60 * 1000);
    return _metaCache;
}

async function getRandomBacklinks(topic_id, language, website_id, count = 3) {
    try {
        // Lấy random backlinks từ link_inventory, không trùng nhau
        const [rows] = await db.query(
            `SELECT DISTINCT li.url, li.anchor_text
             FROM link_inventory li
             JOIN site_main w ON w.id = li.website_id
             LEFT JOIN site_topics wt ON wt.website_id = w.id
             WHERE li.is_active = 1
               AND w.level = 3
               AND w.status = 'active'
               AND w.language = ?
               AND w.id != ?
               ${topic_id ? 'AND (wt.topic_id = ? OR wt.topic_id IS NULL)' : ''}
             ORDER BY RAND()
             LIMIT ?`,
            topic_id ? [language, website_id, topic_id, count] : [language, website_id, count]
        );
        return rows || [];
    } catch (e) {
        console.warn(`   [Backlink] getRandomBacklinks error: ${e.message}`);
        return [];
    }
}

// Inject multiple backlinks vào bài — phân bố đều trong content
function injectMultipleBacklinks(content, backlinks) {
    if (!backlinks || backlinks.length === 0) return content;
    
    // Tìm tất cả vị trí </p>
    const paragraphs = [];
    let match;
    const regex = /<\/p>/g;
    while ((match = regex.exec(content)) !== null) {
        paragraphs.push(match.index + 4); // sau </p>
    }
    
    if (paragraphs.length < 3) {
        // Fallback: append tất cả links cuối bài
        const linksHtml = backlinks.map(link => 
            `\n<p><a href="${link.url}" title="${link.anchor_text}" rel="dofollow">${link.anchor_text}</a></p>`
        ).join('');
        
        if (content.includes('</article>')) {
            return content.replace('</article>', linksHtml + '</article>');
        }
        return content + linksHtml;
    }
    
    // Phân bố backlinks đều trong bài
    const positions = [];
    const step = Math.floor(paragraphs.length / (backlinks.length + 1));
    for (let i = 1; i <= backlinks.length; i++) {
        const pos = Math.min(step * i, paragraphs.length - 1);
        positions.push(paragraphs[pos]);
    }
    
    // Insert từ cuối lên đầu để không ảnh hưởng index
    positions.sort((a, b) => b - a);
    let result = content;
    
    for (let i = 0; i < positions.length && i < backlinks.length; i++) {
        const link = backlinks[i];
        const linkHtml = `\n<p><a href="${link.url}" title="${link.anchor_text}" rel="dofollow">${link.anchor_text}</a></p>`;
        result = result.slice(0, positions[i]) + linkHtml + result.slice(positions[i]);
    }
    
    return result;
}

async function claimBatch() {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // Lấy BATCH_SIZE articles pending với website_id (chỉ Tier 3)
        const [rows] = await conn.query(
            `SELECT a.id, a.raw_id, a.language, a.slug, a.status, a.flow, a.variant, a.website_id, a.tier,
                    a.topic_id, a.site_type_id,
                    ra.origin_id, ra.source_url, ra.title_raw, ra.content_raw,
                    ra.featured_image, ra.category,
                    w.site_name, w.domain
             FROM art_processed a
             JOIN art_raw ra ON ra.id = a.raw_id
             LEFT JOIN site_main w ON w.id = a.website_id
             WHERE a.status = 'pending' AND a.website_id IS NOT NULL AND a.tier = 3
             ORDER BY a.created_at ASC
             LIMIT ?
             FOR UPDATE SKIP LOCKED`,
            [BATCH_SIZE]
        );

        if (rows.length) {
            const ids = rows.map(r => r.id);
            await conn.query(
                `UPDATE art_processed SET status = 'processing' WHERE id IN (${ids.map(() => '?').join(',')})`,
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
    console.log(`[Worker] [${article.language}] [${article.site_name}] [Tier ${article.tier}] attempt ${attempts}/${MAX_RETRIES}: "${article.title_raw?.slice(0, 55)}"`);

    try {
        const { topic_id, site_type_id, website_id } = article;

        // Fetch 3 random backlinks khác nhau cho website này
        const backlinks = await getRandomBacklinks(topic_id, article.language, website_id, 3);
        if (backlinks.length > 0) {
            console.log(`   🔗 [Backlinks] Found ${backlinks.length} links for website_id=${website_id}:`);
            backlinks.forEach((link, i) => console.log(`      ${i+1}. ${link.url} | "${link.anchor_text}"`));
        } else {
            console.warn(`   ⚠️ [Backlinks] No backlinks found for website_id=${website_id} topic_id=${topic_id} lang=${article.language}`);
        }

        // Rewrite content — AI sẽ tạo content, sau đó chúng ta inject backlinks
        const result = await rewriteAllLanguages(
            article.content_raw, article.title_raw, article.featured_image,
            [article.language], null // không pass backlinks vào AI, sẽ inject sau
        );
        const ai = result.articles[article.language];

        if (!ai) {
            console.warn(`   ⚠️ [${article.language}] AI generation failed`);
            if (attempts < MAX_RETRIES) {
                console.log(`   🔄 Will retry (attempt ${attempts}/${MAX_RETRIES})`);
                await Article.updateStatus(article.id, 'pending');
            } else {
                console.error(`   ❌ Max retries reached, marking as ai_error`);
                await Article.updateStatus(article.id, 'ai_error');
                retryCount.delete(key);
            }
            return;
        }

        // Inject multiple backlinks vào content
        if (backlinks.length > 0) {
            ai.content = injectMultipleBacklinks(ai.content, backlinks);
            console.log(`   ✅ [Backlinks] Injected ${backlinks.length} backlinks into content`);
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
        console.log(`   ✅ [${article.language}] [${article.site_name}] [Tier ${article.tier}] topic_id=${topic_id} site_type_id=${site_type_id} website_id=${website_id} | ${ai.title.slice(0, 60)}`);
        retryCount.delete(key);
    } catch (e) {
        console.error(`   ❌ [${article.language}] [${article.site_name}] [Tier ${article.tier}] Error: ${e.message}`);
        
        // Check if error is rate limit related
        const isRateLimitError = e.message?.toLowerCase().includes('rate') || 
                                 e.message?.includes('429') ||
                                 e.message?.toLowerCase().includes('quota');
        
        if (isRateLimitError) {
            console.log(`   ⏰ Rate limit detected, will retry later`);
            await Article.updateStatus(article.id, 'pending');
            retryCount.delete(key); // Reset retry count for rate limit errors
        } else if (attempts < MAX_RETRIES) {
            console.log(`   🔄 Will retry (attempt ${attempts}/${MAX_RETRIES})`);
            await Article.updateStatus(article.id, 'pending');
        } else {
            console.error(`   ❌ Max retries reached, marking as ai_error`);
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

        console.log(`\n[Worker] Processing ${jobs.length} Tier 3 articles for specific websites...`);

        for (const article of jobs) {
            await processOne(article);
            await new Promise(r => setTimeout(r, DELAY_BETWEEN_ARTICLES)); // 5s delay giữa các bài
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
        `UPDATE art_processed SET status = 'pending'
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
