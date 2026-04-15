/**
 * Minimal Article model — writes directly to shared MySQL DB
 * Same table structure as backend models/Article.js
 */
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
        const sql = parts.join(' AND ') || '1=1';
        const [[row]] = await db.query(`SELECT id, origin_id, language FROM articles WHERE ${sql} LIMIT 1`, params);
        return row || null;
    },

    async create(data) {
        const slug = slugify(data.title_ai || data.title_raw || `article-${Date.now()}`);
        const [result] = await db.query(
            `INSERT INTO articles
             (origin_id, language, source_url, title_raw, content_raw, title_ai, content_ai,
              slug, meta_description, focus_keyword, featured_image, author,
              post_date, category, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
            [
                data.origin_id || null, data.language || 'English', data.source_url || null,
                data.title_raw || null, data.content_raw || null,
                data.title_ai || null, data.content_ai || null,
                slug, data.meta_description || null, data.focus_keyword || null,
                data.featured_image || null, data.author || 'Admin',
                toDatetime(data.post_date), data.category || 'Cricket News',
                data.status || 'processed'
            ]
        );
        const id = result.insertId;
        if (data.keywords?.length) {
            for (const kw of data.keywords) {
                if (kw) await db.query(
                    `INSERT IGNORE INTO article_keywords (article_id, keyword) VALUES (?,?)`,
                    [id, String(kw).slice(0, 255)]
                );
            }
        }
        return { id, ...data };
    }
};

module.exports = Article;
