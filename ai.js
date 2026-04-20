require('dotenv').config();
const axios = require('axios');
const { HfInference } = require('@huggingface/inference');

const aiConfig = {
    sambanova: [process.env.SAMBANOVA_KEY_1, process.env.SAMBANOVA_KEY_2].filter(Boolean),
    groq:      [process.env.GROQ_KEY_1,      process.env.GROQ_KEY_2].filter(Boolean),
    cerebras:  [process.env.CEREBRAS_KEY_1,  process.env.CEREBRAS_KEY_2].filter(Boolean),
    cohere:    [process.env.COHERE_KEY_1,    process.env.COHERE_KEY_2].filter(Boolean),
    hf:        [process.env.HF_KEY_1,        process.env.HF_KEY_2].filter(Boolean),
};

function getProviders() {
    const list = [];
    aiConfig.sambanova.forEach((k, i) => list.push({ name: `SAMBANOVA_${i+1}`, type: 'openai', url: 'https://api.sambanova.ai/v1/chat/completions',   model: 'Meta-Llama-3.3-70B-Instruct', key: k }));
    aiConfig.groq.forEach((k, i)      => list.push({ name: `GROQ_${i+1}`,      type: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile',     key: k }));
    aiConfig.cerebras.forEach((k, i)  => list.push({ name: `CEREBRAS_${i+1}`,  type: 'openai', url: 'https://api.cerebras.ai/v1/chat/completions',     model: 'llama3.1-8b',                 key: k }));
    aiConfig.cohere.forEach((k, i)    => list.push({ name: `COHERE_${i+1}`,    type: 'cohere', url: 'https://api.cohere.com/v2/chat',                  model: 'command-r-plus',              key: k }));
    aiConfig.hf.forEach((k, i)        => list.push({ name: `HF_${i+1}`,        type: 'sdk',    model: 'Qwen/Qwen2.5-72B-Instruct',                     key: k }));
    return list;
}

function hasGarbageContent(text) {
    if (!text || text.length < 20) return true;
    const hexChunks = (text.match(/\b[0-9a-f]{6,}\b/gi) || []);
    if (hexChunks.length > 3) return true;
    const nonPrintable = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    if (nonPrintable > 5) return true;
    const letters = (text.match(/[\p{L}]/gu) || []).length;
    if (letters / text.length < 0.3) return true;
    return false;
}

function validateAIOutput(parsed, lang) {
    if (!parsed || !parsed.title || !parsed.content) return false;
    if (parsed.title.trim().length < 10 || parsed.content.trim().length < 200) return false;
    if (hasGarbageContent(parsed.title) || hasGarbageContent(parsed.content)) return false;
    const langChecks = {
        'Hindi':   /[\u0900-\u097F]/,
        'Bengali': /[\u0980-\u09FF]/,
        'Urdu':    /[\u0600-\u06FF]/,
    };
    if (langChecks[lang] && !langChecks[lang].test(parsed.content)) {
        console.warn(`      ⚠️ Output sai ngôn ngữ (expected ${lang})`);
        return false;
    }
    return true;
}

function cleanAndParseJSON(text) {
    if (!text) return null;
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        let cleaned = jsonMatch[0];
        cleaned = cleaned.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) =>
            '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
        );
        cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(cleaned.replace(/[\x00-\x1F\x7F-\x9F]/g, ''));
    } catch { return null; }
}

async function callMultiAI(prompt, targetLang = 'English', providerIdx = 0) {
    const providers = getProviders();
    if (providerIdx >= providers.length) {
        console.error('❌ All AI providers failed');
        return null;
    }
    const ai = providers[providerIdx];
    if (!ai.key) return callMultiAI(prompt, targetLang, providerIdx + 1);

    console.log(`   [AI] Trying ${ai.name}...`);
    try {
        let text = '';
        if (ai.type === 'openai') {
            const res = await axios.post(ai.url, {
                model: ai.model,
                messages: [
                    { role: 'system', content: 'You output pure valid JSON only. No markdown, no explanation, no code blocks.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' },
                max_tokens: 4000
            }, { headers: { Authorization: `Bearer ${ai.key}` }, timeout: 40000 });
            text = res.data.choices[0].message.content;
        } else if (ai.type === 'cohere') {
            const res = await axios.post(ai.url, {
                model: ai.model,
                messages: [
                    { role: 'system', content: 'You output pure valid JSON only. No markdown, no explanation, no code blocks.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' }
            }, { headers: { Authorization: `Bearer ${ai.key}`, 'Content-Type': 'application/json' }, timeout: 40000 });
            text = res.data.message?.content?.[0]?.text || '';
        } else {
            const hf = new HfInference(ai.key);
            const res = await hf.chatCompletion({
                model: ai.model,
                messages: [
                    { role: 'system', content: 'You output pure valid JSON only. No markdown, no explanation.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 4000
            });
            text = res.choices[0].message.content;
        }

        const parsed = cleanAndParseJSON(text);
        if (parsed) return parsed;
        console.warn(`      ⚠️ ${ai.name} JSON parse failed -> next...`);
        return callMultiAI(prompt, targetLang, providerIdx + 1);

    } catch (e) {
        const msg = e.message || '';
        const isNoCredits = msg.includes('depleted') || msg.includes('credits') || msg.includes('subscribe');
        const is429 = e.response?.status === 429 || msg.includes('429') || msg.toLowerCase().includes('rate');
        if (isNoCredits) {
            console.warn(`      ⚠️ ${ai.name} no credits -> skip`);
        } else if (is429) {
            console.log(`      🔄 ${ai.name} rate limit -> wait 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        } else {
            console.log(`      🔄 ${ai.name} error (${msg.slice(0, 80)}) -> next...`);
        }
        return callMultiAI(prompt, targetLang, providerIdx + 1);
    }
}

async function analyzeArticle(rawContent, title) {
    const prompt = `You are a sports news analyst. Extract key facts from this cricket article.
OUTPUT pure JSON only:
{
  "match": "teams and match info",
  "result": "match result or current status",
  "key_players": ["player1 - what they did"],
  "key_stats": ["stat1", "stat2"],
  "key_moments": ["moment1", "moment2"],
  "context": "brief background (2-3 sentences)",
  "category": "IPL 2026 / Test Cricket / ODI / T20I"
}
ARTICLE TITLE: ${title}
ARTICLE CONTENT: ${rawContent?.slice(0, 2500)}`;
    return await callMultiAI(prompt, 'English', 0);
}

// Classify topic và site type từ danh sách thực trong DB
async function classifyArticle(rawContent, title, topics = [], siteTypes = []) {
    const topicList    = topics.map(t => `"${t.name}"`).join(', ');
    const siteTypeList = siteTypes.map(t => `"${t.name}"`).join(', ');

    const prompt = `You are a content classifier. Read this cricket article and pick EXACTLY ONE topic and ONE site type from the lists below.

AVAILABLE TOPICS (pick exactly one): [${topicList}]
AVAILABLE SITE TYPES (pick exactly one): [${siteTypeList}]

RULES:
- You MUST return a value from the list above, do NOT invent new ones
- Pick the most relevant match based on article content
- If unsure about topic, pick the closest match
- If unsure about site type, pick the closest match

OUTPUT pure JSON only:
{
  "topic": "exact name from AVAILABLE TOPICS list",
  "site_type": "exact name from AVAILABLE SITE TYPES list"
}

ARTICLE TITLE: ${title}
ARTICLE CONTENT: ${rawContent?.slice(0, 1500)}`;

    const result = await callMultiAI(prompt, 'English', 0);
    return result;
}

async function writeArticleFromFacts(facts, originalTitle, targetLanguage, interlink = null) {
    const langInstructions = {
        'English': 'Write in fluent, engaging British/American English.',
        'Hindi':   'हिंदी में लिखें। भारतीय क्रिकेट प्रशंसकों के लिए उत्साहजनक शैली में।',
        'Bengali': 'বাংলায় লিখুন। বাংলাদেশ ও পশ্চিমবঙ্গের পাঠকদের জন্য আকর্ষণীয় করুন।',
        'Urdu':    'اردو میں لکھیں۔ پاکستانی شائقین کے لیے پرجوش انداز میں۔'
    };

    const interlinkInstruction = interlink
        ? `INTERLINK REQUIREMENT (MANDATORY):
- You MUST naturally embed this link once inside the article body, within a relevant sentence or paragraph.
- Use the anchor text as the clickable text, do NOT place it in a standalone <p> tag.
- Example: <a href="${interlink.url}" title="${interlink.anchor_text}" rel="dofollow">${interlink.anchor_text}</a>
- Place it where it reads naturally in context, around the middle of the article.`
        : '';

    const prompt = `You are an elite Sports Journalist. Write a complete SEO-optimized cricket article in ${targetLanguage}.
LANGUAGE INSTRUCTION: ${langInstructions[targetLanguage] || langInstructions['English']}
WRITE ENTIRELY IN ${targetLanguage}. Every word must be in ${targetLanguage}.
KEY FACTS TO USE:
${JSON.stringify(facts, null, 2)}
ORIGINAL TITLE (for reference): ${originalTitle}
${interlinkInstruction}
ARTICLE REQUIREMENTS:
- 900-1200 words
- Engaging, viral-worthy sports writing
- Add analysis, fan reactions, expert insights beyond the facts
- HTML structure: <h2> sections, <h3> sub-sections, <p> paragraphs, <strong> for names/stats, <ul><li> for lists
- No markdown, HTML only
OUTPUT pure JSON only:
{
  "title": "compelling SEO title in ${targetLanguage} (55-65 chars)",
  "content": "full HTML article in ${targetLanguage}",
  "meta_description": "SEO meta in ${targetLanguage} (145-158 chars)",
  "focus_keyword": "main keyword in ${targetLanguage}",
  "keywords": ["kw1","kw2","kw3","kw4","kw5","kw6"]
}`;
    const result = await callMultiAI(prompt, targetLanguage, 0);
    if (result && validateAIOutput(result, targetLanguage)) return result;
    return null;
}

async function writeDirect(postContent, title, targetLanguage, interlink = null) {
    const langInstructions = {
        'English': 'Write in fluent English.',
        'Hindi':   'हिंदी में लिखें।',
        'Bengali': 'বাংলায় লিখুন।',
        'Urdu':    'اردو میں لکھیں۔'
    };

    const interlinkInstruction = interlink
        ? `INTERLINK REQUIREMENT (MANDATORY):
- Naturally embed this link once inside the article body within a relevant sentence.
- Use the anchor text as clickable text, do NOT place it in a standalone <p> tag.
- Example: <a href="${interlink.url}" title="${interlink.anchor_text}" rel="dofollow">${interlink.anchor_text}</a>
- Place it where it reads naturally in context, around the middle of the article.`
        : '';

    const prompt = `Rewrite this cricket article in ${targetLanguage}. ${langInstructions[targetLanguage] || ''}
Write ENTIRELY in ${targetLanguage}.
${interlinkInstruction}
Output pure JSON only:
{
  "title": "SEO title in ${targetLanguage}",
  "content": "HTML article in ${targetLanguage} (min 600 words)",
  "meta_description": "meta in ${targetLanguage}",
  "focus_keyword": "keyword in ${targetLanguage}",
  "keywords": ["kw1","kw2","kw3","kw4","kw5"]
}
TITLE: ${title}
CONTENT: ${postContent?.slice(0, 2000)}`;
    const result = await callMultiAI(prompt, targetLanguage, 0);
    if (result && validateAIOutput(result, targetLanguage)) return result;
    return null;
}

async function rewriteAllLanguages(content, title, image, langs = ['English', 'Hindi', 'Bengali', 'Urdu'], interlink = null) {
    console.log(`   📊 Analyzing article...`);
    const facts = await analyzeArticle(content, title);

    const results = {};
    for (const lang of langs) {
        console.log(`   ✍️  Writing [${lang}]${interlink ? ' + interlink' : ''}...`);
        if (facts) {
            results[lang] = await writeArticleFromFacts(facts, title, lang, interlink);
            if (!results[lang]) {
                console.warn(`   ⚠️ [${lang}] facts write failed, trying direct...`);
                results[lang] = await writeDirect(content, title, lang, interlink);
            }
        } else {
            results[lang] = await writeDirect(content, title, lang, interlink);
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    return { articles: results };
}

module.exports = { rewriteAllLanguages, analyzeArticle, classifyArticle };
