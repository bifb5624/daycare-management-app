// Vercel Serverless Function: AI呼び出しの本部一括プロキシ(2026-09-08)
// 各事業所がAPIキーを個別設定しなくても、本部がVercelの環境変数に1つ設定すれば全店でAIが使える。
//
// 環境変数（Vercel > Settings > Environment Variables）:
//   ANTHROPIC_API_KEY - 本部のClaude APIキー(Sensitive)。未設定ならconfigured:falseを返し、
//                        アプリは従来どおり各店の「各種設定→モニタリング」のAPIキーへフォールバックする。
//
// GET  /api/ai-draft            → { configured: true/false }（本部キーが設定済みか）
// POST /api/ai-draft            → Anthropic Messages APIへ転送し、応答をそのまま返す
//   body: { model, max_tokens, messages, system?, storeId? }
//   storeId は将来の「料金プランごとのAI利用可否・上限」判定用に受け取っておく(現状は全店許可)。
//   ★ プラン制御を入れる場合はここで storeId → プラン(app_state等)を照合して 403 を返す設計。
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return res.status(200).json({ configured: !!key });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!key) return res.status(200).json({ notConfigured: true });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { model, max_tokens, messages, system } = body;
  if (!model || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'model と messages は必須です' });
  }
  // 安全上限: 1回のリクエストの出力トークンを制限(コスト暴走防止)
  const _maxTok = Math.min(Number(max_tokens) || 1000, 4000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: _maxTok, messages, ...(system ? { system } : {}) }),
    });
    const data = await resp.json().catch(() => ({}));
    return res.status(resp.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'AI呼び出しに失敗しました: ' + String((e && e.message) || e) });
  }
}
