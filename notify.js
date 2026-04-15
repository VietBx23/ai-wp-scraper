/**
 * Notify backend API → emit Socket.io events về frontend
 * Non-blocking, ignore errors
 */
require('dotenv').config();
const axios = require('axios');

const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const SECRET = process.env.CRAWLER_SECRET || 'crawler_secret_2026';

const headers = { 'x-crawler-secret': SECRET };

async function post(path, body = {}) {
    if (!BACKEND_URL) return;
    try {
        await axios.post(`${BACKEND_URL}${path}`, body, { headers, timeout: 6000 });
    } catch (_) {}
}

const notify     = (event, data) => post('/api/crawler/notify', { event, data });
const cycleStart = ()            => post('/api/crawler/cycle-start');
const cycleEnd   = (stats = {})  => post('/api/crawler/cycle-end', { stats });

module.exports = { notify, cycleStart, cycleEnd };
