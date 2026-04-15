require('dotenv').config();
const cron = require('node-cron');
const { cycleStart, cycleEnd } = require('./notify');

const espn            = require('./sources/espn');
const bdcrictime      = require('./sources/bdcrictime');
const cricketaddictor = require('./sources/cricketaddictor');
const crictoday       = require('./sources/crictoday');

const SCHEDULE = process.env.CRON_SCHEDULE || '*/10 * * * *';

let isRunning = false;

async function runCycle() {
    if (isRunning) { console.log('[Crawler] Skipping — previous cycle still running.'); return; }
    isRunning = true;
    console.log(`\n--- [Crawler] Cycle start: ${new Date().toISOString()} ---`);
    await cycleStart();
    let totalNew = 0;
    try {
        await espn.run().catch(e => console.error('[ESPN] Fatal:', e.message));
        await bdcrictime.run().catch(e => console.error('[BDCric] Fatal:', e.message));
        await cricketaddictor.run().catch(e => console.error('[CricketAddictor] Fatal:', e.message));
        await crictoday.run().catch(e => console.error('[CricToday] Fatal:', e.message));
    } finally {
        isRunning = false;
        await cycleEnd({ totalNew });
        console.log(`--- [Crawler] Cycle end: ${new Date().toISOString()} ---\n`);
    }
}

// Run once immediately on start
runCycle();

// Run on --once flag (no cron)
if (process.argv.includes('--once')) {
    console.log('[Crawler] --once mode, exiting after first cycle.');
    // process exits naturally after runCycle completes
} else {
    console.log(`[Crawler] Cron scheduled: ${SCHEDULE}`);
    cron.schedule(SCHEDULE, runCycle);
}
