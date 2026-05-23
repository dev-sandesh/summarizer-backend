// Vercel serverless function — CommonJS syntax for maximum compatibility

const STYLE_PROMPTS = {
  bullet:    'Provide a summary as clear, concise bullet points (5–8 bullets). Each bullet should capture one key idea. Use "•" as the bullet character.',
  tldr:      'Write a single TL;DR paragraph (3–5 sentences) that captures the essence of the article.',
  takeaways: 'Extract 5 detailed key takeaways. For each, write 2–3 sentences explaining why it matters. Number them 1–5.',
  qa:        'Summarize as 4–5 Q&A pairs. Format each as "Q: [question]\\nA: [answer]".',
};

const TONE_PROMPTS = {
  professional: 'Use a professional, formal tone.',
  casual:       'Use a friendly, conversational tone as if explaining to a colleague.',
  technical:    'Be concise and technical — skip fluff, focus on data and specifics.',
  eli5:         'Explain simply, as if to someone with no background in the topic (ELI5 style).',
};

// Simple in-memory rate limit: max 10 requests per IP per minute
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const maxReqs = 10;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= maxReqs) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify shared token
  const token = req.headers['x-extension-token'];
  if (token !== process.env.EXTENSION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Rate limit by IP
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { title = '', text = '', style = 'bullet', tone = 'professional' } = req.body || {};
  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'No article content provided.' });
  }

  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.bullet;
  const tonePrompt  = TONE_PROMPTS[tone]   || TONE_PROMPTS.professional;

  const prompt = `You are an expert article summarizer. ${tonePrompt} ${stylePrompt} Do not include any preamble — output only the summary itself.

Article title: "${title}"

Article content:
${text.substring(0, 14000)}`;

  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Server misconfiguration: missing API key.' });

    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
          temperature: 0.4,
        }),
      }
    );

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Groq API error ${groqRes.status}`);
    }

    const data = await groqRes.json();
    const summary = data?.choices?.[0]?.message?.content;
    if (!summary) throw new Error('No summary returned from Groq.');

    return res.status(200).json({ summary });

  } catch (err) {
    console.error('Summarize error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
