/**
 * AI service — copied from backend services/ai.service.js
 * Standalone, no socket dependency
 */
require('dotenv').config();
const axios = require('axios');
const { HfInference } = require('@huggingface/inference');

const aiConfig = {
    sambanova: [process.env.SAMBANOVA_KEY_1, process.env.SAMBANOVA_KEY_2].filter(Boolean),
    cerebras:  [process.env.CEREBRAS_KEY_1,  process.env.CEREBRAS_KEY_2].filter(Boolean),
    groq:      [process.env.GROQ_KEY_1,      process.env.GROQ_KEY_2].filter(Boolean),
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

function cleanAndParseJSON(text) {
    if (!text) return null;
    try {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        let c = m[0];
        c = c.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) =>
            '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
        );
        c = c.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(c.replace(/[\x00-\x1F\x7F-\x9F]/g, ''));
    } catch { return null; }
}

function validateOutput(parsed, lang) {
    if (!parsed?.title || !parsed?.content) return false;
    if (parsed.title.trim().length < 10 || parsed.content.trim().length < 200) return false;
    const checks = { Hindi: /[\u0900-\u097F]/, Bengali: /[\u0980-\u09FF]/, Urdu: /[\u0600-\u06FF]/ };
    if (checks[lang] && !checks[lang].test(parsed.content)) return false;
    return true;
}

async function callAI(prompt, lang = 'English', idx = 0) {
    const providers = getProviders();
    if (idx >= providers.length) { console.error('❌ All AI providers failed'); return null; }
    const ai = providers[idx];
    if (!ai.key) return callAI(prompt, lang, idx + 1);
    try {
        let text = '';
        if (ai.type === 'openai') {
            const res = await axios.post(ai.url, {
                model: ai.model,
                messages: [{ role: 'system', content: 'Output pure valid JSON only.' }, { role: 'user', content: prompt }],
                response_format: { type: 'json_object' }, max_tokens: 4000
            }, { headers: { Authorization: `Bearer ${ai.key}` }, timeout: 40000 });
            text = res.data.choices[0].message.content;
        } else if (ai.type === 'cohere') {
            const res = await axios.post(ai.url, {
                model: ai.model,
                messages: [{ role: 'system', content: 'Output pure valid JSON only.' }, { role: 'user', content: prompt }],
                response_format: { type: 'json_object' }
            }, { headers: { Authorization: `Bearer ${ai.key}`, 'Content-Type': 'application/json' }, timeout: 40000 });
            text = res.data.message?.content?.[0]?.text || '';
        } else {
            const hf = new HfInference(ai.key);
            const res = await hf.chatCompletion({ model: ai.model, messages: [{ role: 'system', content: 'Output pure valid JSON only.' }, { role: 'user', content: prompt }], max_tokens: 4000 });
            text = res.choices[0].message.content;
        }
        const parsed = cleanAndParseJSON(text);
        if (parsed) return parsed;
        return callAI(prompt, lang, idx + 1);
    } catch (e) {
        const msg = e.message || '';
        if (!msg.includes('depleted') && !msg.includes('credits')) {
            if (e.response?.status === 429 || msg.includes('rate')) await new Promise(r => setTimeout(r, 2000));
        }
        return callAI(prompt, lang, idx + 1);
    }
}

async function analyzeArticle(content, title) {
    const prompt = `Extract key facts from this cricket article as pure JSON:
{"match":"teams info","result":"result/status","key_players":["player - action"],"key_stats":["stat"],"key_moments":["moment"],"context":"background","category":"IPL/Test/ODI/T20I"}
TITLE: ${title}
CONTENT: ${content?.slice(0, 2500)}`;
    return await callAI(prompt, 'English');
}

async function writeFromFacts(facts, title, lang) {
    const langMap = {
        English: 'Write in fluent English.',
        Hindi:   'हिंदी में लिखें।',
        Bengali: 'বাংলায় লিখুন।',
        Urdu:    'اردو میں لکھیں۔',
    };
    const prompt = `Write a complete SEO-optimized cricket article in ${lang}. ${langMap[lang] || ''}
WRITE ENTIRELY IN ${lang}. Use these facts:
${JSON.stringify(facts, null, 2)}
ORIGINAL TITLE: ${title}
Requirements: 900-1200 words, HTML format (h2/h3/p/strong/ul), no markdown.
Output pure JSON: {"title":"...","content":"...","meta_description":"...","focus_keyword":"...","keywords":["kw1","kw2","kw3","kw4","kw5"]}`;
    const result = await callAI(prompt, lang);
    if (result && validateOutput(result, lang)) return result;
    return null;
}

async function rewriteAllLanguages(content, title, image, langs = ['English', 'Hindi', 'Bengali', 'Urdu']) {
    console.log(`   📊 Analyzing article...`);
    const facts = await analyzeArticle(content, title);
    const results = {};
    for (const lang of langs) {
        console.log(`   ✍️  Writing [${lang}]...`);
        if (facts) {
            results[lang] = await writeFromFacts(facts, title, lang);
        } else {
            // Fallback direct rewrite
            const prompt = `Rewrite in ${lang}. Output JSON: {"title":"...","content":"HTML 600+ words","meta_description":"...","focus_keyword":"...","keywords":["kw1","kw2"]}
TITLE: ${title}
CONTENT: ${content?.slice(0, 2000)}`;
            const r = await callAI(prompt, lang);
            results[lang] = (r && validateOutput(r, lang)) ? r : null;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return results;
}

module.exports = { rewriteAllLanguages };
