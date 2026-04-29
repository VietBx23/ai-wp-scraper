const db = require('./db');

function slugify(text) {
    if (!text) return `article-${Date.now()}`;
    return text.toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '').replace(/--+/g, '-')
        .substring(0, 120) || `article-${Date.now()}`;
}

function toDatetime(d) {
    if (!d) return null;
    const dt = new Date(d);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 19).replace('T', ' ');
}

const Article = {

    /**
     * Check source_url đã tồn tại chưa — dùng UNIQUE index trên art_raw
     */
    async isSourceDuplicate(sourceUrl) {
        const [[row]] = await db.query(
            `SELECT id FROM art_raw WHERE source_url = ? LIMIT 1`,
            [String(sourceUrl).slice(0, 767)]
        );
        if (row) {
            console.log(`   [DupCheck] Already exists: ${String(sourceUrl).slice(0, 80)}`);
            return true;
        }
        return false;
    },

    /**
     * Check title similarity trong ngày — fallback khi source_url không đủ tin cậy
     */
    async isTitleDuplicate(newTitle, threshold = 0.6) {
        const today = new Date().toISOString().slice(0, 10);
        const [rows] = await db.query(
            `SELECT title_raw FROM art_raw WHERE DATE(created_at) = ? AND title_raw IS NOT NULL`,
            [today]
        );
        const normalize = t => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
        const newWords = new Set(normalize(newTitle));
        for (const { title_raw } of rows) {
            const existWords = new Set(normalize(title_raw));
            const intersection = [...newWords].filter(w => existWords.has(w)).length;
            const union = new Set([...newWords, ...existWords]).size;
            if (union > 0 && intersection / union >= threshold) {
                console.log(`   [DupCheck] Similar title skipped: "${newTitle.slice(0, 60)}"`);
                return true;
            }
        }
        return false;
    },

    /**
     * Crawlers gọi hàm này:
     * 1. Check duplicate qua UNIQUE source_url
     * 2. Classify AI 1 lần → topic_id (không cần site_type_id nữa)
     * 3. Tìm tất cả websites match topic
     * 4. Insert art_raw (1 row — nội dung gốc thuần túy)
     * 5. Insert art_processed cho từng website cụ thể
     */
    async classifyAndQueue(detail) {
        const { classifyArticle } = require('./ai');

        const sourceUrl = String(detail.source_url || detail.origin_id || '').slice(0, 767);
        if (!sourceUrl) {
            console.warn(`   [Queue] No source_url — skip`);
            return 0;
        }

        // Check duplicate bằng UNIQUE index
        const [[existing]] = await db.query(
            `SELECT id FROM art_raw WHERE source_url = ? LIMIT 1`, [sourceUrl]
        );
        if (existing) {
            console.log(`   [Skip] Already exists: ${sourceUrl.slice(0, 80)}`);
            return 0;
        }

        // Load topics only (không cần site_types)
        const [topics] = await db.query(`SELECT DISTINCT id, name FROM site_tags WHERE is_active = 1`);

        // Classify 1 lần — chỉ cần topic
        let topic_id = null;
        try {
            const cls = await classifyArticle(detail.content_raw, detail.title_raw, topics);
            if (cls?.topic) {
                const t = topics.find(t => t.name.toLowerCase() === cls.topic.toLowerCase().trim());
                if (t) topic_id = t.id;
                else console.warn(`   [Classify] Topic "${cls.topic}" not in DB`);
            }
        } catch (e) {
            console.warn(`   [Classify] Error: ${e.message}`);
        }

        if (!topic_id) {
            console.warn(`   [Classify] ❌ Failed to classify topic — skip "${detail.title_raw?.slice(0, 50)}"`);
            return 0;
        }

        // Tìm tất cả websites Tier 3 ACTIVE match topic (không check type_id)
        const [matchingWebsites] = await db.query(
            `SELECT DISTINCT w.id, w.site_name, w.language, w.type_id, w.level
             FROM site_main w
             LEFT JOIN site_topics wt ON wt.website_id = w.id
             WHERE w.status = 'active'
               AND w.level = 3
               AND (wt.topic_id = ? OR wt.topic_id IS NULL)
             ORDER BY w.id`,
            [topic_id]
        );

        if (matchingWebsites.length === 0) {
            console.warn(`   [Classify] ❌ No active Tier 3 websites match topic_id=${topic_id} — skip`);
            return 0;
        }

        console.log(`   [Classify] ✅ topic_id=${topic_id} | ${matchingWebsites.length} active Tier 3 websites | "${detail.title_raw?.slice(0, 50)}"`);
        matchingWebsites.forEach(w => console.log(`      → ${w.site_name} (${w.language}) - Tier ${w.level} [ACTIVE]`));

        // Insert art_raw — chỉ lưu nội dung gốc
        const [rawResult] = await db.query(
            `INSERT IGNORE INTO art_raw
             (source_url, origin_id, title_raw, content_raw,
              featured_image, author, post_date, category)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
                sourceUrl,
                detail.origin_id || null,
                detail.title_raw || null,
                detail.content_raw || null,
                detail.featured_image || null,
                detail.author || 'Admin',
                toDatetime(detail.post_date),
                detail.category || 'Cricket News',
            ]
        );

        if (rawResult.affectedRows === 0) {
            console.log(`   [Skip] art_raw race condition: ${sourceUrl.slice(0, 80)}`);
            return 0;
        }

        const rawId = rawResult.insertId;

        // Insert art_processed cho từng website cụ thể
        let totalQueued = 0;
        for (let i = 0; i < matchingWebsites.length; i++) {
            const website = matchingWebsites[i];
            const variant = i + 1; // variant 1, 2, 3...
            
            const baseSlug = slugify(detail.title_raw || `article-${Date.now()}`);
            const slug = matchingWebsites.length > 1 ? `${baseSlug}-${website.id}` : baseSlug;
            
            // Lưu site_type_id từ website (nếu có)
            const [result] = await db.query(
                `INSERT IGNORE INTO art_processed
                 (raw_id, language, slug, topic_id, site_type_id, flow, status, variant, website_id, tier)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [rawId, website.language, slug, topic_id, website.type_id || null, 1, 'pending', variant, website.id, website.level]
            );
            if (result.affectedRows > 0) {
                totalQueued++;
                console.log(`   [Queue] → website_id=${website.id} (${website.site_name}) lang=${website.language} tier=${website.level} variant=${variant}`);
            }
        }

        console.log(`   [Queue] raw_id=${rawId} → ${totalQueued} articles queued for ${matchingWebsites.length} Tier 3 websites`);
        return totalQueued;
    },

    /**
     * Worker gọi sau khi AI gen xong
     */
    async updateAI(id, ai, titleRaw, topic_id = null, site_type_id = null) {
        const slug = slugify(titleRaw || ai.title);
        await db.query(
            `UPDATE art_processed SET
                title_ai = ?, content_ai = ?, slug = ?,
                meta_description = ?, focus_keyword = ?,
                topic_id     = COALESCE(?, topic_id),
                site_type_id = COALESCE(?, site_type_id),
                status = 'processed'
             WHERE id = ?`,
            [
                ai.title, ai.content, slug,
                ai.meta_description || null, ai.focus_keyword || null,
                topic_id, site_type_id,
                id,
            ]
        );
        if (ai.keywords?.length) {
            // Note: article_keywords table might not exist, we'll handle this gracefully
            try {
                const values = ai.keywords.filter(k => k).map(kw => [id, String(kw).slice(0, 255)]);
                await db.query(`INSERT IGNORE INTO article_keywords (article_id, keyword) VALUES ?`, [values]);
            } catch (e) {
                console.warn(`   [Keywords] Table might not exist: ${e.message}`);
            }
        }
    },

    async updateStatus(id, status) {
        await db.query(`UPDATE art_processed SET status = ? WHERE id = ?`, [status, id]);
    },
};

module.exports = Article;
