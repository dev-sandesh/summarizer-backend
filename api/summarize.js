const GROQ_API_URL    = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL      = 'llama-3.3-70b-versatile';
const POSTHOG_API_URL = 'https://us.i.posthog.com/capture/';

const STYLE_PROMPTS = {
  bullet:    'Summarize as a concise bullet-point list (5-8 bullets). Each bullet captures one key idea.',
  tldr:      'Write a single TL;DR paragraph (3-5 sentences) capturing the most important points.',
  takeaways: 'Extract 5-7 key takeaways. Each should be a complete, standalone insight.',
  qa:        'Generate 4-5 Q&A pairs covering the most important aspects. Format as "Q: ...\nA: ..."',
};

const TONE_PROMPTS = {
  professional: 'Use a professional, formal tone.',
  casual:       'Use a casual, conversational tone — like explaining to a friend.',
  technical:    'Be concise and precise. Use technical language where appropriate. Avoid filler.',
  eli5:         'Explain as simply as possible, as if to someone with no background. No jargon.',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-extension-token'];
  if (process.env.EXTENSION_TOKEN && token !== process.env.EXTENSION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { title, text, style = 'bullet', tone = 'professional' } = req.body || {};
  if (!text || text.length < 100) {
    return res.status(400).json({ error: 'Not enough article content' });
  }

  // Anonymised distinct_id — first 16 chars of a SHA-256 of the IP.
  // Lets us count unique users without storing PII.
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const distinctId = hashId(ip);

  const s = STYLE_PROMPTS[style] || STYLE_PROMPTS.bullet;
  const t = TONE_PROMPTS[tone]   || TONE_PROMPTS.professional;
  const systemPrompt = `You are an assistant that summarizes web articles. ${s} ${t} Output only the summary — no preamble like "Here is a summary of...".`;
  const userMessage  = title ? `Title: ${title}\n\n${text}` : text;

  try {
    const groqRes = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:    GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
        max_tokens:  1024,
        temperature: 0.3,
      }),
    });

    if (groqRes.status === 429) {
      await capture(distinctId, 'summarize_failed', { reason: 'groq_quota', style, tone });
      return res.status(429).json({ error: 'Daily quota exhausted. Please try again tomorrow.' });
    }
    if (!groqRes.ok) {
      const body = await groqRes.json().catch(() => ({}));
      await capture(distinctId, 'summarize_failed', { reason: 'groq_error', status: groqRes.status, style, tone });
      return res.status(502).json({ error: body?.error?.message || `Groq error ${groqRes.status}` });
    }

    const data    = await groqRes.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      await capture(distinctId, 'summarize_failed', { reason: 'empty_response', style, tone });
      return res.status(502).json({ error: 'Empty response from Groq' });
    }

    await capture(distinctId, 'page_summarized', {
      style,
      tone,
      text_length: text.length,
      summary_length: summary.length,
      model: GROQ_MODEL,
    });

    return res.status(200).json({ summary, model: 'Llama 3.3 70B · Groq' });

  } catch (err) {
    await capture(distinctId, 'summarize_failed', { reason: 'server_error', style, tone });
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};

async function capture(distinctId, event, properties = {}) {
  if (!process.env.POSTHOG_API_KEY) return;
  await fetch(POSTHOG_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:     process.env.POSTHOG_API_KEY,
      event,
      distinct_id: distinctId,
      properties,
    }),
  }).catch(() => {});
}

function hashId(ip) {
  return require('crypto').createHash('sha256').update(ip).digest('hex').slice(0, 16);
}
