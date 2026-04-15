# ai-wp-scraper

> GitHub: https://github.com/VietBx23/ai-wp-scraper

Standalone cricket news scraper với queue-based AI processing. Chạy độc lập, không phụ thuộc backend.

## Kiến trúc

```
Crawlers (ESPN / BDCricTime / CricketAddictor / CricToday)
    ↓  mỗi 10 phút, push raw articles
crawl_queue (MySQL table)
    ↓  AI Worker poll mỗi 15 giây
AI Worker → analyze → rewrite 4 ngôn ngữ
    ↓  lưu vào articles table (status: processed)
notify → Backend API → Socket.io → Frontend
    ↓
Backend auto-publish → WordPress sites
```

## Setup

```bash
git clone https://github.com/VietBx23/ai-wp-scraper.git
cd ai-wp-scraper
npm install
cp .env.example .env
# Điền MySQL credentials (cùng DB với backend) và AI keys
```

## Chạy

```bash
# Chạy liên tục (crawl cron + worker)
npm start

# Crawl 1 lần rồi chờ worker xử lý hết queue
npm run crawl

# Chỉ chạy worker (không crawl)
npm run worker
```

## Files

| File | Vai trò |
|------|---------|
| `index.js` | Entry point, orchestrate crawlers + worker |
| `queue.js` | Queue manager (MySQL `crawl_queue` table) |
| `worker.js` | AI Worker — poll queue, rewrite, save articles |
| `ai.js` | AI service với multi-provider failover |
| `article.js` | Article model — ghi vào shared MySQL |
| `notify.js` | Notify backend API |
| `sources/*.js` | Crawlers — chỉ scrape + push vào queue |

## Environment Variables

Xem `.env.example`
