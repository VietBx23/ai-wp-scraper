/**
 * Sends real-time events to backend → Socket.io → frontend
 */
require('dotenv').config();
const axios = require('axios');

const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const SECRET = process.env.CRAWLER_SECRET || 'crawler_secret_2026';

async function notify(event, data = {}) {
    if (!BACKEND_URL) return;
    try {
        await axios.post(`${BACKEND_URL}/api/crawler/notify`, { event, data }, {
            headers: { 'x-crawler-secret': SECRET },
            timeout: 5000
        });
    } catch (_) {} // non-blocking, ignore errors
}

async function cycleStart() {
    if (!BACKEND_URL) return;
    try {
        await axios.post(`${BACKEND_URL}/api/crawler/cycle-start`, {}, {
            headers: { 'x-crawler-secret': SECRET }, timeout: 5000
        });
    } catch (_) {}
}

async function cycleEnd(stats = {}) {
    if (!BACKEND_URL) return;
    try {
        await axios.post(`${BACKEND_URL}/api/crawler/cycle-end`, { stats }, {
            headers: { 'x-crawler-secret': SECRET }, timeout: 5000
        });
    } catch (_) {}
}

module.exports = { notify, cycleStart, cycleEnd };
