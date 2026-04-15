const axios = require('axios');
const he = require('he');
const Article = require('../article');
const { rewriteAllLanguages } = require('../ai');
const { notify } = require('../notify');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 3;

async function run() {
    if (!process.env.CRAWL_URL) { console.log('[BDCric] CRAWL_URL not set, skipping.'); return; }
    console.log('[BDCric] Checking for new articles...');
    let page = 1, total = 0, running = true;
    try {
        while (running && total < MAX) {
            const res = await axios.get(`${process.env.CRAWL_URL}?page=${page}`, { timeout: 20000 });
            const posts = res.data?.data;
            if (!posts?.length) break;
            for (const item of posts) {
                if (total >= MAX) { running = false; break; }
                const postDate = new Date(item.post_date);
                const today = new Date();
                const isToday = postDate.toDateString() === today.toDateString();
                if (!isToday) { running = false; break; }
                const exists = await Article.findOne({ $or: [{ origin_id: String(item.ID) }, { source_url: item.guid }] });
                if (exists) continue;
                const content = he.decode(item.post_content || '');
                const langs = ['English', 'Hindi', 'Bengali', 'Urdu'];
                const results = await rewriteAllLanguages(content, item.post_title, item.attachments?.[0]?.guid || null, langs);
                for (const lang of langs) {
                    const ai = results[lang];
                    if (!ai) continue;
                    await Article.create({
                        origin_id: String(item.ID), source_url: item.guid, language: lang,
                        title_raw: item.post_title, content_raw: content,
                        featured_image: item.attachments?.[0]?.guid || null,
                        author: item.user?.[0]?.display_name || 'Admin',
                        post_date: new Date(item.post_date),
                        title_ai: ai.title, content_ai: ai.content,
                        meta_description: ai.meta_description, focus_keyword: ai.focus_keyword,
                        keywords: ai.keywords, status: 'processed'
                    });
                    console.log(`   ✅ [${lang}] ${ai.title}`);
                    await notify('article_processed', { title: ai.title, language: lang, source: 'BDCricTime', status: 'processed' });
                }
                total++;
            }
            page++;
            await new Promise(r => setTimeout(r, 1500));
        }
        console.log(`[BDCric] Done. ${total} new articles.`);
    } catch (e) { console.error('[BDCric] Error:', e.message); }
}

module.exports = { run };
