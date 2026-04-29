# AI-WP-Scraper Troubleshooting Guide

## 🔍 Common Errors & Solutions

### 1. ❌ "No active Tier 3 websites match type_id=X topic_id=Y"

**Nguyên nhân:**
- Không có site nào ở Tier 3 với status='active'
- Hoặc site không có topic/site_type phù hợp

**Giải pháp:**

```bash
# Kiểm tra cấu hình sites
node check-sites.js
```

**Cần đảm bảo:**
1. Có ít nhất 1 site với:
   - `level = 3` (Tier 3)
   - `status = 'active'`
   - `type_id` khớp với site_types
   
2. Site phải có topic mapping trong `site_topics`:
   ```sql
   INSERT INTO site_topics (website_id, topic_id) VALUES (1, 2);
   ```

3. Hoặc để site không có topic → sẽ match ALL topics

**Ví dụ tạo site Tier 3:**
```sql
-- Tạo site
INSERT INTO site_main (site_name, domain, status, level, language, type_id)
VALUES ('Cricket News Site', 'https://example.com', 'active', 3, 'English', 1);

-- Gán topics cho site (website_id = 1)
INSERT INTO site_topics (website_id, topic_id) VALUES 
(1, 1), -- IPL
(1, 2), -- World Cup
(1, 3); -- Player Stats
```

---

### 2. ❌ "Article.findOne is not a function"

**Nguyên nhân:**
- Source file đang gọi method không tồn tại trong Article model

**Giải pháp:**
✅ Đã fix trong `bdcrictime_web.js` - dùng `Article.classifyAndQueue()` thay vì `Article.findOne()`

**Các method có sẵn trong Article:**
- `Article.isSourceDuplicate(url)` - Check URL duplicate
- `Article.isTitleDuplicate(title)` - Check title similarity
- `Article.classifyAndQueue(detail)` - Classify & queue article
- `Article.updateAI(id, ai, titleRaw)` - Update AI content
- `Article.updateStatus(id, status)` - Update status

---

### 3. ❌ ESPN Blocked (403)

**Nguyên nhân:**
- ESPN có Cloudflare/anti-bot protection
- Axios headers không đủ để bypass

**Giải pháp:**
✅ Đã fix - dùng `got-scraping` thay vì `axios`

`got-scraping` tự động:
- Rotate user agents
- Mimic real browser headers
- Handle cookies & redirects

**Nếu vẫn bị block:**
1. Tăng delay giữa requests (đã set 1.5s)
2. Dùng proxy (nếu cần)
3. Tạm disable ESPN source trong `index.js`

---

### 4. 🔄 "SAMBANOVA_1 rate limit → wait 5s..."

**Nguyên nhân:**
- AI provider rate limit (429)
- Hoặc hết credits

**Giải pháp:**
✅ Hệ thống tự động:
- Retry với provider khác
- Fallback chain: SAMBANOVA → GROQ → CEREBRAS → COHERE → HF

**Để giảm rate limit:**
1. Thêm nhiều API keys trong `.env`:
   ```env
   SAMBANOVA_KEY_1=xxx
   SAMBANOVA_KEY_2=yyy
   GROQ_KEY_1=zzz
   GROQ_KEY_2=aaa
   ```

2. Giảm `MAX_NEW_PER_CYCLE` trong `.env`:
   ```env
   MAX_NEW_PER_CYCLE=3
   ```

3. Tăng delay giữa AI calls (đã có 2s)

---

### 5. ⚠️ "Output sai ngôn ngữ (expected Hindi)"

**Nguyên nhân:**
- AI model không tuân thủ language instruction
- Model không support ngôn ngữ đó tốt

**Giải pháp:**
✅ Hệ thống tự động validate & reject

**Để cải thiện:**
1. Dùng model tốt hơn (Llama 3.3 70B)
2. Strengthen prompt instructions
3. Add more validation rules

---

### 6. ❌ "Classify ❌ Failed — skip"

**Nguyên nhân:**
- AI không trả về topic hoặc site_type
- Hoặc trả về giá trị không có trong DB

**Giải pháp:**

1. **Kiểm tra topics & site_types:**
   ```bash
   node check-sites.js
   ```

2. **Đảm bảo có data:**
   ```sql
   -- Topics
   SELECT * FROM site_tags WHERE is_active = 1;
   
   -- Site Types
   SELECT * FROM site_types WHERE is_active = 1;
   ```

3. **Nếu thiếu, thêm vào:**
   ```sql
   INSERT INTO site_tags (name, slug, is_active) VALUES 
   ('IPL', 'ipl', 1),
   ('World Cup', 'world-cup', 1),
   ('Player Stats', 'player-stats', 1);
   
   INSERT INTO site_types (name, slug, is_active) VALUES 
   ('Cricket News', 'cricket-news', 1),
   ('Match Prediction', 'match-prediction', 1);
   ```

---

## 🔧 Diagnostic Commands

### Check database configuration:
```bash
node check-sites.js
```

### Check MySQL connection:
```bash
mysql -u root -p
USE your_database;
SHOW TABLES;
```

### Check environment variables:
```bash
cat .env | grep -E "SAMBANOVA|GROQ|DATABASE"
```

### Test single source:
```javascript
// In index.js, comment out other sources
const sources = [
    // require('./sources/espn'),
    require('./sources/bdcrictime'),
    // require('./sources/bdcrictime_web'),
];
```

---

## 📊 Monitoring

### Watch logs in real-time:
```bash
npm start
```

### Check database stats:
```sql
-- Pending articles
SELECT COUNT(*) FROM art_processed WHERE status = 'pending';

-- Processed articles
SELECT COUNT(*) FROM art_processed WHERE status = 'processed';

-- Published articles
SELECT COUNT(*) FROM art_posts;

-- Articles by site
SELECT w.site_name, COUNT(*) as total
FROM art_posts ap
JOIN site_main w ON w.id = ap.website_id
GROUP BY w.site_name;
```

---

## 🚀 Performance Tips

1. **Reduce crawl frequency:**
   ```javascript
   // In index.js
   cron.schedule('*/30 * * * *', runCrawlers); // Every 30 min instead of 10
   ```

2. **Limit articles per cycle:**
   ```env
   MAX_NEW_PER_CYCLE=3
   ```

3. **Disable slow sources:**
   ```javascript
   const sources = [
       // require('./sources/espn'), // Disable if too slow
       require('./sources/bdcrictime'),
   ];
   ```

4. **Use PM2 for production:**
   ```bash
   pm2 start index.js --name ai-scraper
   pm2 logs ai-scraper
   ```

---

## 📝 Logs Location

- Console output: Real-time
- PM2 logs: `~/.pm2/logs/`
- Application logs: Check `index.js` for custom logging

---

## 🆘 Still Having Issues?

1. Check database schema matches code
2. Verify all environment variables are set
3. Test MySQL connection manually
4. Check AI provider API keys are valid
5. Review recent code changes

**Common fixes:**
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Reset database (careful!)
mysql -u root -p < schema.sql

# Clear old data
DELETE FROM art_processed WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
```
