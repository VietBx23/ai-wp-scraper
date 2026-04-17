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
     * Crawlers gọi hàm này — insert raw content, status: pending
     * Chưa có title_ai/content_ai, worker sẽ xử lý sau
     */
    async createPending(data) {
        const slug = slugify(data.title_raw || `article-${Date.now()}`);
        const [result] = await db.query(
            `INSERT INTO articles
             (origin_id, language, source_url, title_raw, content_raw,
              slug, featured_image, author, post_date, category, status, flow, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
            [
                data.origin_id || null, data.language || 'English', data.source_url || null,
                data.title_raw || null, data.content_raw || null,
                slug, data.featured_image || null, data.author || 'Admin',
                toDatetime(data.post_date), data.category || 'Cricket News',
                'pending', data.flow || 1,
            ]
        );
        return { id: result.insertId, ...data };
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
