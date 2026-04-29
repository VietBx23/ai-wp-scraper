const axios = require('axios');
const cheerio = require('cheerio');
const Article = require('../article');

const MAX = parseInt(process.env.MAX_NEW_PER_CYCLE) || 5;
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
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
        const { data } = await axios.get(url, {
            headers: { ...HEADERS, Referer: 'https://www.espncricinfo.com/cricket-news' },
            timeout: 25000,
            maxRedirects: 5,
        });
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
        const { data } = await axios.get('https://www.espncricinfo.com/cricket-news', {
            headers: HEADERS, 
            timeout: 30000,
            maxRedirects: 5,
        });
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
            
            // Check if already exists
            if (await Article.isSourceDuplicate(url)) continue;
            
            const detail = await scrapeDetail(url);
            if (!detail) continue;
            if (await Article.isTitleDuplicate(detail.title)) continue;
            
            const queued = await Article.classifyAndQueue({
                origin_id: url, source_url: url,
                title_raw: detail.title, content_raw: detail.content,
                featured_image: detail.featured_image, author: detail.author,
                category: detail.category, post_date: new Date(),
            });
            if (queued > 0) {
                console.log(`[ESPN] Queued (${queued} variants): ${detail.title.slice(0, 60)}`);
                count++;
            }
            await new Promise(r => setTimeout(r, 1500)); // Longer delay to avoid rate limits
        }
        console.log(`[ESPN] Done. ${count} articles queued.`);
    } catch (e) {
        if (e.response?.status === 403) {
            console.log('[ESPN] Blocked (403) - ESPN has anti-bot protection. Consider using got-scraping or disable this source.');
        } else {
            console.error('[ESPN] Error:', e.message);
        }
    }
}

module.exports = { run };
