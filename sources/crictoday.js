const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const Article = require('../article');
const { rewriteAllLanguages } = require('../ai');
const { notify } = require('../notify');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0' };
const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 3;

async function scrapeDetail(url) {
    try {
        const { data } = await axios.get(url, { headers: HEADERS });
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
        const items = $('.gh-archive-page-post').toArray();
        for (const el of items) {
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
            const langs = ['English', 'Hindi', 'Bengali', 'Urdu'];
            const results = await rewriteAllLanguages(detail.content, detail.title, detail.featured_image, langs);
            for (const lang of langs) {
                const ai = results[lang];
                if (!ai) continue;
                await Article.create({ origin_id: originId, source_url: link, language: lang, title_raw: detail.title, content_raw: detail.content, featured_image: detail.featured_image, author: 'CricToday', category: 'Cricket News', post_date: new Date(), title_ai: ai.title, content_ai: ai.content, meta_description: ai.meta_description, focus_keyword: ai.focus_keyword, keywords: ai.keywords, status: 'processed' });
                console.log(`   ✅ [${lang}] ${ai.title}`);
                await notify('article_processed', { title: ai.title, language: lang, source: 'CricToday', status: 'processed' });
            }
            count++;
        }
        console.log(`[CricToday] Done. ${count} new articles.`);
    } catch (e) { console.error('[CricToday] Error:', e.message); }
}

module.exports = { run };
