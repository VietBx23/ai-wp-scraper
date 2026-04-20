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

// Cache topics từ DB, refresh mỗi 10 phút
let _topicCache = null;
let _topicCacheTime = 0;

async function getTopics() {
    if (_topicCache && Date.now() - _topicCacheTime < 10 * 60 * 1000) return _topicCache;
    const [rows] = await db.query(`SELECT id, name, slug FROM topics WHERE is_active = 1`);
    _topicCache = rows;
    _topicCacheTime = Date.now();
    return rows;
}

// Match title/category với topic trong DB
async function matchTopic(title, category) {
    const topics = await getTopics();
    const text = `${title} ${category}`.toLowerCase();
    for (const topic of topics) {
        const keywords = topic.name.toLowerCase().split(/[\s,\/]+/);
        if (keywords.some(kw => kw.length > 2 && text.includes(kw))) {
            return topic.id;
        }
    }
    return null;
}

const Article = {
    async findOne(where) {
        const parts = [], params = [];
        for (const [k, v] of Object.entries(where)) {
            if (k === '$or') {
                const orParts = v.map(cond => {
                    const [ck, cv] = Object.entries(cond)[0];
                    params.push(cv);
                    return `${ck} = ?`;
                });
                parts.push(`(${orParts.join(' OR ')})`);
            } else {
                parts.push(`${k} = ?`); params.push(v);
            }
        }
        const [[row]] = await db.query(
            `SELECT id, origin_id, language FROM articles WHERE ${parts.join(' AND ') || '1=1'} LIMIT 1`,
            params
        );
        return row || null;
    },

    /**
     * Check title similarity trước khi crawl — tránh trùng nội dung từ nhiều nguồn
     * Trả về true nếu đã có bài tương tự hôm nay
     */
    async isTitleDuplicate(newTitle, threshold = 0.6) {
        const today = new Date().toISOString().slice(0, 10);
        // Check tất cả ngôn ngữ, chỉ cần 1 bài English trùng là đủ để skip
        const [rows] = await db.query(
            `SELECT title_raw FROM articles WHERE DATE(created_at) = ? AND title_raw IS NOT NULL GROUP BY title_raw`,
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
     * Crawlers gọi hàm này — insert raw content, status: pending
     * Chưa có title_ai/content_ai, worker sẽ xử lý sau
     */
    async createPending(data) {
        const slug = slugify(data.title_raw || `article-${Date.now()}`);

        // Auto-match topic nếu chưa có
        const topic_id = data.topic_id || await matchTopic(data.title_raw || '', data.category || '');

        // INSERT IGNORE — nếu (origin_id, language) đã tồn tại thì bỏ qua
        const [result] = await db.query(
            `INSERT IGNORE INTO articles
             (origin_id, language, source_url, title_raw, content_raw,
              slug, featured_image, author, post_date, category, topic_id, status, flow, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
            [
                data.origin_id || null, data.language || 'English', data.source_url || null,
                data.title_raw || null, data.content_raw || null,
                slug, data.featured_image || null, data.author || 'Admin',
                toDatetime(data.post_date), data.category || 'Cricket News',
                topic_id,
                'pending', data.flow || 1,
            ]
        );
        if (result.affectedRows === 0) {
            console.log(`   [Skip] Already exists: origin_id=${data.origin_id} lang=${data.language}`);
            return null;
        }
        if (topic_id) console.log(`   [Topic] Matched topic_id=${topic_id} for "${data.title_raw?.slice(0,50)}"`);
        return { id: result.insertId, ...data, topic_id };
    },

    /**
     * Worker gọi hàm này sau khi AI xong
     * Update title_ai, content_ai, status: processed
     */
    async updateAI(id, ai, titleRaw) {
        // Dùng titleRaw (English) để tạo slug, không dùng title_ai (có thể là Urdu/Hindi/Bengali)
        const slug = slugify(titleRaw || ai.title);
        await db.query(
            `UPDATE articles SET
                title_ai = ?, content_ai = ?, slug = ?,
                meta_description = ?, focus_keyword = ?,
                status = 'processed'
             WHERE id = ?`,
            [
                ai.title, ai.content, slug,
                ai.meta_description || null, ai.focus_keyword || null,
                id,
            ]
        );
        // if (ai.keywords?.length) {
        //     for (const kw of ai.keywords) {
        //         if (kw) await db.query(
        //             `INSERT IGNORE INTO article_keywords (article_id, keyword) VALUES (?,?)`,
        //             [id, String(kw).slice(0, 255)]
        //         );
        //     }
        // }
        if (ai.keywords?.length) {
            const values = ai.keywords.filter(k => k).map(kw => [id, String(kw).slice(0, 255)]);
            await db.query(`INSERT IGNORE INTO article_keywords (article_id, keyword) VALUES ?`, [values]);
        }
    },

    async updateStatus(id, status) {
        await db.query(`UPDATE articles SET status = ? WHERE id = ?`, [status, id]);
    },
};

module.exports = Article;
