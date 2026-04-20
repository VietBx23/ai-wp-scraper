const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const Article = require('../article');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 5;
const LANGS = ['English', 'Hindi', 'Bengali', 'Urdu'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0' };

async function scrapeDetail(url) {
    try {
        const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
        const $ = cheerio.load(data);
        $('.responsive-ad-css, .trusted-wrapper, script, ins, style').remove();
        const title = $('.gh-post-page__title').text().trim();
        const featured_image = $('meta[property="og:image"]').attr('content') || '';
        const content = $('.post-content').text().trim();
        if (!title || content.length < 200) return null;
        return { title, featured_image, content };
    } catch (e) { console.error(`[CricToday] ${e.message}`); return null; }
}

async function run() {
    const todayStr = dayjs().format('MMM DD, YYYY');
    console.log(`[CricToday] Scanning (today: ${todayStr})...`);
    let count = 0;
    try {
        const { data } = await axios.get('https://crictoday.com/cricket/news?page=1', { headers: HEADERS });
        const $ = cheerio.load(data);
        for (const el of $('.gh-archive-page-post').toArray()) {
            if (count >= MAX) break;
            const $el = $(el);
            const rawDate = $el.find('.gh-post-info__date').text().trim();
            if (rawDate && !rawDate.includes(todayStr)) { console.log(`[CricToday] Old article, stopping.`); break; }
            let link = $el.find('.gh-archive-page-post-title-link').attr('href');
            if (!link) continue;
            if (!link.startsWith('http')) link = 'https://crictoday.com' + link;
            const originId = 'crictoday-' + link.split('/').filter(Boolean).pop();
            const exists = await Article.findOne({ origin_id: originId });
            if (exists) continue;
            const detail = await scrapeDetail(link);
            if (!detail) continue;
            if (await Article.isTitleDuplicate(detail.title)) continue;
            for (const lang of LANGS) {
                await Article.createPending({
                    origin_id: originId, source_url: link, language: lang,
                    title_raw: detail.title, content_raw: detail.content,
                    featured_image: detail.featured_image, author: 'CricToday',
                    category: 'Cricket News', post_date: new Date(),
                });
            }
            console.log(`[CricToday] Queued: ${detail.title.slice(0, 60)}`);
            count++;
        }
        console.log(`[CricToday] Done. ${count} articles queued.`);
    } catch (e) { console.error('[CricToday] Error:', e.message); }
}

module.exports = { run };
