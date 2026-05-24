module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'No message provided' });
  }

  if (!process.env.WEB3FORMS_KEY) {
    return res.status(500).json({ error: 'Feedback not configured' });
  }

  const r = await fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_key: process.env.WEB3FORMS_KEY,
      subject:    'Page Summarizer — User Feedback',
      message:    message.trim(),
    }),
  }).catch(() => null);

  if (!r?.ok) return res.status(502).json({ error: 'Failed to send' });
  return res.status(200).json({ ok: true });
};
