// Vercel Serverless Function: 不具合レポートを本部へメール送信
// 環境変数:
//   BREVO_API_KEY        - Brevo の API キー
//   BREVO_SENDER_EMAIL   - 送信元メール (Brevo 認証済み)
//   REPORT_TO_EMAIL      - 受信先 (未設定なら support@ones-style.co.jp)
//
// POST /api/report  { description, context }
//   context = { facility, storeId, recorder, view, url, userAgent, appVersion, when, errors:[...] }
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const description = String(body.description || '').slice(0, 4000);
  const ctx = body.context || {};

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@ones-style.co.jp';
  const toEmail = process.env.REPORT_TO_EMAIL || 'support@ones-style.co.jp';
  if (!apiKey) return res.status(500).json({ error: 'サーバー設定エラー: BREVO_API_KEY が未設定です' });

  const errLines = Array.isArray(ctx.errors) && ctx.errors.length
    ? ctx.errors.map((e, i) => `${i + 1}. ${esc(e)}`).join('<br/>')
    : '（記録されたエラーはありません）';

  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif;color:#1e293b;padding:20px;">
  <h2 style="color:#b45309;margin:0 0 12px;">🐞 つむぎ 不具合レポート</h2>
  <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:14px;margin-bottom:16px;">
    <div style="font-weight:bold;margin-bottom:6px;">利用者(報告者)からの内容</div>
    <div style="font-size:14px;line-height:1.8;">${esc(description) || '（説明なし）'}</div>
  </div>
  <table style="border-collapse:collapse;font-size:12px;width:100%;">
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;white-space:nowrap;">事業所</td><td style="padding:4px 8px;">${esc(ctx.facility)}（store: ${esc(ctx.storeId)}）</td></tr>
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;">担当者</td><td style="padding:4px 8px;">${esc(ctx.recorder)}</td></tr>
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;">画面</td><td style="padding:4px 8px;">${esc(ctx.view)}</td></tr>
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;">発生日時</td><td style="padding:4px 8px;">${esc(ctx.when)}</td></tr>
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;">URL</td><td style="padding:4px 8px;word-break:break-all;">${esc(ctx.url)}</td></tr>
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;">バージョン</td><td style="padding:4px 8px;">${esc(ctx.appVersion)}</td></tr>
    <tr><td style="padding:4px 8px;font-weight:bold;background:#f1f5f9;">端末</td><td style="padding:4px 8px;word-break:break-all;">${esc(ctx.userAgent)}</td></tr>
  </table>
  <div style="margin-top:16px;font-weight:bold;">直近のエラー</div>
  <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px;font-size:11px;line-height:1.7;font-family:monospace;">${errLines}</div>
</body></html>`.trim();

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: 'つむぎ 不具合レポート' },
        to: [{ email: toEmail }],
        replyTo: { email: toEmail },
        subject: `【つむぎ不具合】${(ctx.facility || '事業所')} / ${(ctx.view || '')}`.slice(0, 120),
        htmlContent: html,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(500).json({ error: 'メール送信に失敗しました', detail: t.slice(0, 300) });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: '送信に失敗しました', detail: String(e.message || e) });
  }
}
