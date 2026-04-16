require('dotenv').config();
const cron = require('node-cron');
const { startWorker } = require('./worker');

const espn            = require('./sources/espn');
const bdcrictime      = require('./sources/bdcrictime');
const bdcrictimeWeb   = require('./sources/bdcrictime_web');
const cricketaddictor = require('./sources/cricketaddictor');
const crictoday       = require('./sources/crictoday');

const SCHEDULE = process.env.CRON_SCHEDULE || '*/10 * * * *';
let isCrawling = false;

async function runCrawlCycle() {
    if (isCrawling) { console.log('[Crawler] Skipping — previous cycle still running.'); return; }
    isCrawling = true;
    console.log(`\n--- [Crawler] Start: ${new Date().toISOString()} ---`);
    try {
        await espn.run().catch(e            => console.error('[ESPN] Fatal:', e.message));
        await bdcrictime.run().catch(e      => console.error('[BDCric] Fatal:', e.message));
        await bdcrictimeWeb.run().catch(e   => console.error('[BDCricWeb] Fatal:', e.message));
        await cricketaddictor.run().catch(e => console.error('[CricketAddictor] Fatal:', e.message));
        await crictoday.run().catch(e       => console.error('[CricToday] Fatal:', e.message));
    } catch (e) {
        console.error('[Crawler] Fatal:', e.message);
    } finally {
        isCrawling = false;
        console.log(`--- [Crawler] End: ${new Date().toISOString()} ---\n`);
    }
}

startWorker();

// Health check server cho Render
const PORT = process.env.PORT || 4000;
require('http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ai-wp-scraper', time: new Date().toISOString() }));
}).listen(PORT, () => console.log(`[Scraper] Health check on port ${PORT}`));

runCrawlCycle();

if (!process.argv.includes('--once')) {
    console.log(`[Scraper] Cron: ${SCHEDULE}`);
    cron.schedule(SCHEDULE, runCrawlCycle);
}
