/**
 * BDCricTime Web Crawler — scrape bdcrictime.com/news
 * Dùng axios + cheerio thay Puppeteer (nhẹ hơn, chạy được trên Render)
 */
const axios = require('axios');
const cheerio = require('cheerio');
const Article = require('../article');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 5;
const LANGS = ['English', 'Hindi', 'Bengali', 'Urdu'];
const BASE = 'https://bdcrictime.com';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
};

function getTodayString() {
    // Format: "April 15" — khớp với format trên site
    return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

async function scrapeList() {
    const { data } = await axios.get(`${BASE}/news`, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);
    const today = getTodayString();
    const items = [];

    $('.post2').each((_, el) => {
        const dateText = $(el).find('.date').text().trim();
        if (!dateText.includes(today)) return;
        const link = $(el).find('a').attr('href');
        if (link) items.push({ url: link.startsWith('http') ? link : BASE + link, date: dateText });
    });

    return items;
}

async function scrapeDetail(url) {
    try {
        const { data } = await axios.get(url, { headers: HEADERS, timeout: 25000 });
        const $ = cheerio.load(data);

        const title = $('.post-title-area h1').text().trim() || $('h1').first().text().trim();

        const breadcrumbs = $('.breadcrumb-area ul li a');
        const category = breadcrumbs.length >= 2 ? $(breadcrumbs[1]).text().trim() : 'Cricket News';

        const author = $('.post-auth-info h3 a').text().trim() || 'Editorial';

        const featured_image = $('.single-post-tm img').attr('src')
            || $('meta[property="og:image"]').attr('content')
            || '';

        const keywords = $('meta[name="keywords"]').attr('content') || '';
        const desc = $('meta[name="description"]').attr('content') || '';

        // Clean content
        const contentEl = $('.post-details-content, .single-post-details').first();
        contentEl.find('script, style, ins, iframe, .ad-placeholder').remove();
        const content = contentEl.text().replace(/\s+/g, ' ').trim();

        if (!title || content.length < 100) return null;
        return { title, category, author, featured_image, keywords, desc, content };
    } catch (e) {
        console.error(`[BDCricWeb] Scrape error ${url}: ${e.message}`);
        return null;
    }
}

async function run() {
    console.log(`[BDCricWeb] Scanning (today: ${getTodayString()})...`);
    let count = 0;
    try {
        const items = await scrapeList();
        console.log(`[BDCricWeb] Found ${items.length} articles today.`);

        for (const item of items) {
            if (count >= MAX) break;
            const exists = await Article.findOne({ $or: [{ source_url: item.url }, { origin_id: item.url }] });
            if (exists) continue;

            const detail = await scrapeDetail(item.url);
            if (!detail) continue;

            for (const lang of LANGS) {
                await Article.createPending({
                    origin_id: item.url,
                    source_url: item.url,
                    language: lang,
                    title_raw: detail.title,
                    content_raw: detail.content,
                    featured_image: detail.featured_image,
                    author: detail.author,
                    category: detail.category,
                    post_date: new Date(),
                });
            }
            console.log(`[BDCricWeb] Queued: ${detail.title.slice(0, 60)}`);
            count++;
            await new Promise(r => setTimeout(r, 1000));
        }
        console.log(`[BDCricWeb] Done. ${count} articles queued.`);
    } catch (e) {
        console.error('[BDCricWeb] Error:', e.message);
    }
}

module.exports = { run };
