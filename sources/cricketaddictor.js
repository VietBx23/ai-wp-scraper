const axios = require('axios');
const cheerio = require('cheerio');
const Article = require('../article');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 5;
const LANGS = ['English', 'Hindi', 'Bengali', 'Urdu'];
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' };

function isToday(dateStr) {
    if (!dateStr) return false;
    const now = new Date();
    const month = now.toLocaleString('en-US', { month: 'long' });
    return dateStr.toLowerCase().includes(`${now.getDate()} ${month}, ${now.getFullYear()}`.toLowerCase());
}

async function scrapeDetail(url) {
    try {
        const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
        const $ = cheerio.load(data);
        const article = $('article');
        article.find('.authBx, script, .ads, .toc, style, .breadcrumbList').remove();
        const title = article.find('.post-title').text().trim() || $('h1').first().text().trim();
        const featured_image = $('meta[property="og:image"]').attr('content') || '';
        const author = article.find('.red.ft-bold').first().text().trim() || 'CricketAddictor Staff';
        const category = $('.breadcrumbList li').eq(1).find('span').text().trim() || 'News';
        const content = article.find('p').map((_, el) => $(el).text().trim()).get().filter(t => t.length > 10).join('\n\n');
        if (!title || content.length < 100) return null;
        return { title, featured_image, author, category, content };
    } catch (e) {
        if (e.response?.status !== 403) console.error(`[CricketAddictor] ${e.message}`);
        return null;
    }
}

async function run() {
    console.log('[CricketAddictor] Scanning...');
    let count = 0;
    try {
        const { data } = await axios.get('https://cricketaddictor.com/ipl-2026/news/', {
            headers: HEADERS, timeout: 30000
        });
        const $ = cheerio.load(data);
        const items = [];
        const seen = new Set();
        $('.toggle-light a[href], .post-item a[href]').each((_, el) => {
            const url = $(el).attr('href');
            if (!url || seen.has(url)) return;
            const timeInfo = $(el).closest('.toggle-light, .post-item').find('.fa-calendar').parent().text().trim() || '';
            seen.add(url);
            items.push({ url, timeInfo });
        });
        for (const { url, timeInfo } of items) {
            if (count >= MAX) break;
            if (timeInfo && !isToday(timeInfo)) continue;
            const exists = await Article.findOne({ $or: [{ source_url: url }, { origin_id: url }] });
            if (exists) continue;
            const detail = await scrapeDetail(url);
            if (!detail) continue;
            if (await Article.isTitleDuplicate(detail.title)) continue;
            for (const lang of LANGS) {
                await Article.createPending({
                    origin_id: url, source_url: url, language: lang,
                    title_raw: detail.title, content_raw: detail.content,
                    featured_image: detail.featured_image, author: detail.author,
                    category: detail.category, post_date: new Date(),
                });
            }
            console.log(`[CricketAddictor] Queued: ${detail.title.slice(0, 60)}`);
            count++;
            await new Promise(r => setTimeout(r, 500));
        }
        console.log(`[CricketAddictor] Done. ${count} articles queued.`);
    } catch (e) {
        if (e.response?.status === 403) console.log('[CricketAddictor] Blocked (403).');
        else console.error('[CricketAddictor] Error:', e.message);
    }
}

module.exports = { run };
