const axios = require('axios');
const cheerio = require('cheerio');
const Article = require('../article');
const { rewriteAllLanguages } = require('../ai');
const { notify } = require('../notify');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 3;
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
};

function isToday(dateStr) {
    if (!dateStr) return false;
    const s = dateStr.toLowerCase().trim();
    if (/min|hr|ago|\d+[mh]/.test(s)) return true;
    const now = new Date();
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const day = String(now.getDate()).padStart(2, '0');
    return s.includes(`${day}-${months[now.getMonth()]}-${now.getFullYear()}`);
}

async function scrapeDetail(url) {
    try {
        const { data } = await axios.get(url, { headers: { ...HEADERS, Referer: 'https://www.espncricinfo.com/cricket-news' }, timeout: 25000 });
        const $ = cheerio.load(data);
        const title = $('h1').first().text().trim();
        const featured_image = $('meta[property="og:image"]').attr('content') || '';
        const author = $('a[href*="/author/"] span').first().text().trim() || 'ESPNcricinfo staff';
        const category = $('a[href*="/genre/"] span').first().text().trim() || 'General News';
        let content = '';
        $('.ci-html-content p, .ds-text-comfortable-l p').each((_, el) => {
            const t = $(el).text().trim();
            if (t.length > 20) content += t + '\n\n';
        });
        if (!title || content.length < 100) return null;
        return { title, featured_image, author, category, content };
    } catch (e) {
        if (e.response?.status !== 403) console.error(`[ESPN] Scrape error: ${e.message}`);
        return null;
    }
}

async function run() {
    console.log('[ESPN] Scanning...');
    let count = 0;
    try {
        const { data } = await axios.get('https://www.espncricinfo.com/cricket-news', { headers: HEADERS, timeout: 30000 });
        const $ = cheerio.load(data);
        const links = [];
        const seen = new Set();
        $('a[href*="/story/"]').each((_, el) => {
            let href = $(el).attr('href') || '';
            if (!href.startsWith('http')) href = 'https://www.espncricinfo.com' + href;
            const url = href.split('?')[0];
            if (!seen.has(url)) {
                seen.add(url);
                const timeInfo = $(el).closest('div').find('.ds-text-compact-xs, time').first().text().trim();
                links.push({ url, timeInfo });
            }
        });
        for (const { url, timeInfo } of links) {
            if (count >= MAX) break;
            if (timeInfo && !isToday(timeInfo)) continue;
            const exists = await Article.findOne({ $or: [{ source_url: url }, { origin_id: url }] });
            if (exists) continue;
            const detail = await scrapeDetail(url);
            if (!detail) continue;
            await saveArticle({ origin_id: url, source_url: url, ...detail });
            count++;
            await new Promise(r => setTimeout(r, 1500));
        }
        console.log(`[ESPN] Done. ${count} new articles.`);
    } catch (e) {
        if (e.response?.status === 403) console.log('[ESPN] Blocked (403).');
        else console.error('[ESPN] Error:', e.message);
    }
}

async function saveArticle(base) {
    const langs = ['English', 'Hindi', 'Bengali', 'Urdu'];
    const results = await rewriteAllLanguages(base.content, base.title, base.featured_image, langs);
    for (const lang of langs) {
        const ai = results[lang];
        if (!ai) { console.log(`   ❌ [${lang}] failed`); continue; }
        await Article.create({ ...base, language: lang, title_ai: ai.title, content_ai: ai.content, meta_description: ai.meta_description, focus_keyword: ai.focus_keyword, keywords: ai.keywords, status: 'processed' });
        console.log(`   ✅ [${lang}] ${ai.title}`);
        await notify('article_processed', { title: ai.title, language: lang, source: 'ESPN', status: 'processed' });
    }
}

module.exports = { run };
