// Vercel Serverless Function: FAXを1件送信（InterFAX REST API 経由・日本国内対応）
// これにより「ボタン1つで、各利用者のモニタリング表を、それぞれの担当ケアマネのFAX番号へ自動送信」を実現する。
//
// 環境変数（Vercel > Settings > Environment Variables）:
//   INTERFAX_USER  - InterFAX のユーザー名（API資格情報）
//   INTERFAX_PASS  - InterFAX のパスワード（API資格情報, Sensitive）
//   ※ InterFAX（https://www.interfax.net/ja/）は送信従量課金。アカウント作成後、上記を設定してください。
//
// クライアントから POST /api/send-fax
// body: { to: "03-1234-5678", html: "<...>", subject?: "..." }
//   to   … 送信先FAX番号（国内表記でOK。内部で +81 形式に変換）
//   html … 送信する書類のHTML（InterFAXがFAX画像に変換）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const user = process.env.INTERFAX_USER;
  const pass = process.env.INTERFAX_PASS;
  if (!user || !pass) {
    return res.status(500).json({ error: 'FAX送信が未設定です（INTERFAX_USER / INTERFAX_PASS を Vercel の環境変数に設定してください）', notConfigured: true });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { to, html, subject } = body;
  if (!to || !html) return res.status(400).json({ error: '送信先FAX番号(to)と本文(html)は必須です' });

  // 国内表記 → 国際表記(+81)。 先頭0を除いて+81を付ける。 すでに+付きはそのまま。
  let d = String(to).replace(/[^0-9+]/g, '');
  let faxNumber;
  if (d.startsWith('+')) faxNumber = d;
  else if (d.startsWith('0')) faxNumber = '+81' + d.slice(1);
  else faxNumber = '+81' + d;
  if (faxNumber.replace(/[^0-9]/g, '').length < 9) {
    return res.status(400).json({ error: `FAX番号の形式が正しくありません: ${to}` });
  }

  try {
    const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const url = `https://rest.interfax.net/outbound/faxes?faxNumber=${encodeURIComponent(faxNumber)}${subject ? `&reference=${encodeURIComponent(String(subject).slice(0,60))}` : ''}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    });
    if (r.status !== 201 && !r.ok) {
      const t = await r.text().catch(() => '');
      let hint = '';
      if (r.status === 401) hint = 'InterFAX の資格情報（INTERFAX_USER / INTERFAX_PASS）が正しくない可能性があります。';
      else if (r.status === 402 || /balance|credit/i.test(t)) hint = 'InterFAX の残高不足の可能性があります。';
      return res.status(r.status).json({ error: `FAX送信に失敗しました (${r.status})`, detail: String(t).slice(0, 300), hint });
    }
    const loc = r.headers.get('location') || '';
    const faxId = loc.split('/').filter(Boolean).pop() || null;
    return res.status(200).json({ success: true, faxId, to: faxNumber });
  } catch (e) {
    return res.status(500).json({ error: 'FAX送信でエラーが発生しました', detail: String(e).slice(0, 300) });
  }
}
