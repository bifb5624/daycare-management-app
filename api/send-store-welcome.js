// Vercel Serverless Function: 店舗アカウント発行(登録完了)メール送信 (Brevo SMTP API)
// つむぎ管理局が店舗を追加したとき、店舗管理者へ「アカウントが発行されました」+ ログインURL/ID/PW を送る。
// 環境変数:
//   BREVO_API_KEY        - Brevo の API キー (Sensitive)
//   BREVO_SENDER_EMAIL   - 送信元メールアドレス (Brevo で認証済みのアドレス)
//
// クライアントから POST /api/send-store-welcome で呼び出し
// body: { to, storeName, orgName?, loginId, loginPw?, loginUrl }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@ones-style.co.jp';
  if (!apiKey) return res.status(500).json({ error: 'BREVO_API_KEY が設定されていません (Vercel の Environment Variables を確認してください)' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { to, storeName, orgName, loginId, loginPw, loginUrl } = body;

  if (!to || !loginUrl || !loginId) return res.status(400).json({ error: '送信先 (to)・ログインURL (loginUrl)・ログインID (loginId) は必須です' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safeStore = esc(storeName || '事業所');
  const subject = `【つむぎ】アカウントが発行されました（${safeStore}）`;

  const pwRow = loginPw
    ? `<tr><td style="padding:6px 12px;color:#64748b;font-weight:bold;white-space:nowrap;">初期パスワード</td><td style="padding:6px 12px;font-family:monospace;font-size:15px;font-weight:bold;color:#0f172a;">${esc(loginPw)}</td></tr>`
    : '';

  const htmlBody = `
<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif;background:#f4f8ed;margin:0;padding:24px;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="text-align:center;border-bottom:2px solid #94c456;padding-bottom:16px;margin-bottom:20px;">
      <div style="font-size:13px;color:#5e8030;font-weight:bold;letter-spacing:2px;">つむぎ（通所介護管理システム）</div>
      <div style="font-size:20px;color:#3d5021;font-weight:bold;margin-top:6px;">アカウントが発行されました</div>
    </div>
    <p style="font-size:14px;line-height:1.8;margin:12px 0;">
      ${orgName ? `<strong>${esc(orgName)}</strong><br/>` : ''}
      <strong>${safeStore}</strong> のアカウントを発行しました。<br/>
      下記のログイン情報でご利用を開始いただけます。
    </p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 6px;margin:18px 0;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 12px;color:#64748b;font-weight:bold;white-space:nowrap;">ログインID</td><td style="padding:6px 12px;font-family:monospace;font-size:15px;font-weight:bold;color:#0f172a;">${esc(loginId)}</td></tr>
        ${pwRow}
      </table>
    </div>
    <div style="text-align:center;margin:26px 0;">
      <a href="${esc(loginUrl)}" style="display:inline-block;background:linear-gradient(135deg,#7daa3d,#5e8030);color:white;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:bold;font-size:15px;letter-spacing:1px;box-shadow:0 4px 12px rgba(94,128,48,0.3);">
        ログインページを開く
      </a>
    </div>
    <p style="font-size:11px;color:#94a3b8;line-height:1.7;margin:16px 0;text-align:center;">
      ボタンが表示されない場合は下記URLをコピーしてブラウザに貼り付けてください<br/>
      <a href="${esc(loginUrl)}" style="color:#5e8030;word-break:break-all;">${esc(loginUrl)}</a>
    </p>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;margin:20px 0;font-size:12px;color:#92400e;line-height:1.8;">
      <strong>ご注意:</strong><br/>
      ・セキュリティのため、<strong>初回ログイン後にパスワードの変更</strong>をおすすめします（各種設定 → ログイン情報）。<br/>
      ・ログイン情報は第三者に共有しないでください。
    </div>
    <p style="font-size:11px;color:#94a3b8;line-height:1.6;margin-top:20px;text-align:center;border-top:1px solid #e2e8f0;padding-top:14px;">
      つむぎ運営（株式会社ワンズスタイル）<br/>
      心当たりがない場合はこのメールを破棄してください
    </p>
  </div>
</body></html>
  `.trim();

  try {
    const payload = {
      sender: { email: senderEmail, name: 'つむぎ運営' },
      to: [{ email: to }],
      subject: subject.slice(0, 100),
      htmlContent: htmlBody,
    };
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let parsed = null; try { parsed = JSON.parse(errText); } catch {}
      const brevoMsg = parsed?.message || parsed?.code || errText.slice(0, 300);
      let hint = '';
      if (/unauthorized|sender/i.test(brevoMsg)) hint = `送信元 ${senderEmail} が Brevo で認証されていません。Brevo ダッシュボード > Senders & IP で認証してください。`;
      else if (/api[- ]?key/i.test(brevoMsg)) hint = 'API キーが無効です。Vercel 環境変数 BREVO_API_KEY を確認してください。';
      return res.status(response.status).json({ error: `Brevo API エラー (${response.status})`, brevoMessage: brevoMsg, hint });
    }
    const data = await response.json().catch(() => ({}));
    return res.status(200).json({ success: true, messageId: data?.messageId || null });
  } catch (e) {
    return res.status(500).json({ error: 'メール送信に失敗しました', detail: String(e).slice(0, 500) });
  }
}
