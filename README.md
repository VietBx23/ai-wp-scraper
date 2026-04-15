# Cricket Crawler

> GitHub: https://github.com/VietBx23/ai-wp-scraper

Standalone crawler service. Crawls cricket news from multiple sources, rewrites with AI (4 languages), and saves directly to the shared MySQL database.

## Setup

```bash
git clone https://github.com/VietBx23/ai-wp-scraper.git
cd ai-wp-scraper
npm install
cp .env.example .env
# Fill in MySQL credentials (same DB as backend) and AI keys
```

## Run

```bash
# Start with cron (every 10 min by default)
npm start

# Run once and exit
npm run crawl
```

## Sources

- ESPN Cricinfo
- BDCricTime API
- CricketAddictor
- CricToday

## How it works

1. Each source crawler checks for new articles today
2. Skips articles already in DB (dedup by `origin_id` / `source_url`)
3. Runs AI rewrite (analyze once → write 4 languages)
4. Saves to `articles` + `article_keywords` tables with `status = 'processed'`
5. Backend auto-publish cron picks up `processed` articles and pushes to WordPress

## Environment Variables

See `.env.example`
