const axios = require('axios');
const he = require('he');
const Article = require('../article');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 5;

async function run() {
    if (!process.env.CRAWL_URL) { console.log('[BDCric] CRAWL_URL not set, skipping.'); return; }
    console.log('[BDCric] Scanning...');
    let page = 1, count = 0, running = true;
    try {
        while (running && count < MAX) {
            const res = await axios.get(`${process.env.CRAWL_URL}?page=${page}`, { timeout: 20000 });
            const posts = res.data?.data;
            if (!posts?.length) break;
            for (const item of posts) {
                if (count >= MAX) { running = false; break; }
                if (new Date(item.post_date).toDateString() !== new Date().toDateString()) { running = false; break; }
                
                // Check duplicate by source URL
                if (await Article.isSourceDuplicate(item.guid)) continue;
                
                const content = he.decode(item.post_content || '');
                if (await Article.isTitleDuplicate(item.post_title)) continue;
                const queued = await Article.classifyAndQueue({
                    origin_id: String(item.ID), source_url: item.guid,
                    title_raw: item.post_title, content_raw: content,
                    featured_image: item.attachments?.[0]?.guid || null,
                    author: item.user?.[0]?.display_name || 'Admin',
                    category: 'Cricket News', post_date: new Date(item.post_date),
                });
                if (queued > 0) {
                    console.log(`[BDCric] Queued (${queued} articles): ${item.post_title.slice(0, 60)}`);
                    count++;
                }
            }
            page++;
            await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[BDCric] Done. ${count} articles queued.`);
    } catch (e) { console.error('[BDCric] Error:', e.message); }
}

module.exports = { run };
