# Optional: Install got-scraping for better anti-bot bypass

## Why got-scraping?

`got-scraping` is better than `axios` for scraping sites with anti-bot protection (like ESPN) because it:
- Automatically rotates user agents
- Mimics real browser fingerprints
- Handles cookies & redirects better
- Has built-in retry logic

## Installation

```bash
cd ai-wp-scraper
npm install got-scraping@^4.2.1
```

## Usage

After installing, ESPN source will automatically work better with 403 blocks.

The current code uses `axios` with improved headers, which works for most cases.
If you still get 403 errors frequently, install `got-scraping` and update `sources/espn.js`:

```javascript
// Replace axios with got-scraping
const { gotScraping } = require('got-scraping');

// In scrapeDetail function:
const response = await gotScraping({
    url,
    headerGeneratorOptions: {
        browsers: ['chrome', 'firefox'],
        devices: ['desktop'],
        locales: ['en-US'],
    },
    timeout: { request: 25000 },
});
const $ = cheerio.load(response.body);
```

## Alternative: Disable ESPN source

If ESPN keeps blocking and you don't want to install got-scraping, you can disable it:

```javascript
// In index.js
const sources = [
    // require('./sources/espn'), // Disabled - too many 403 errors
    require('./sources/bdcrictime'),
    require('./sources/bdcrictime_web'),
    require('./sources/cricketaddictor'),
    require('./sources/crictoday'),
];
```

## Note

Most cricket news sites work fine with `axios`. Only ESPN has strong anti-bot protection.
