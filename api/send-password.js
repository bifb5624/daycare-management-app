// Vercel Serverless Function: パスワード再設定の通知メール送信 (Brevo SMTP API)
// 事業所側の「PW再設定」で発行した新しいパスワードを、登録メールアドレスへ自動送信する。
// 環境変数: BREVO_API_KEY / BREVO_SENDER_EMAIL (api/send-invite.js と共通)
// body: { to, toName?, username, password, facilityName?, facilityPhone?, loginUrl? }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@ones-style.co.jp';
  if (!apiKey) return res.status(500).json({ error: 'BREVO_API_KEY が設定されていません' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { to, toName, username, password, facilityName, facilityPhone, loginUrl } = body;

  if (!to || !username || !password) return res.status(400).json({ error: '送信先(to)・ログインID(username)・パスワード(password)は必須です' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });

  const safeFacility = facilityName || 'デイサービス';
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = `【${safeFacility}】パスワード再設定のご案内`;

  const htmlBody = `
<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP',sans-serif;background:#f4f8ed;margin:0;padding:24px;color:#1e293b;">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="text-align:center;border-bottom:2px solid #94c456;padding-bottom:16px;margin-bottom:20px;">
      <div style="font-size:13px;color:#5e8030;font-weight:bold;letter-spacing:2px;">${esc(safeFacility)}</div>
      <div style="font-size:20px;color:#3d5021;font-weight:bold;margin-top:6px;">パスワード再設定のご案内</div>
    </div>
    <p style="font-size:14px;line-height:1.8;margin:12px 0;">
      ${toName ? `<strong>${esc(toName)} 様</strong><br/>` : ''}
      いつもお世話になっております。<br/>
      ご依頼いただいたパスワードの再設定が完了しましたので、新しいログイン情報をお送りします。
    </p>
    <div style="background:#f4f8ed;border:1px solid #c4dba0;border-radius:10px;padding:16px 18px;margin:20px 0;font-size:14px;line-height:2;">
      <div>ログインID: <strong style="font-family:monospace;font-size:16px;">${esc(username)}</strong></div>
      <div>新しいパスワード: <strong style="font-family:monospace;font-size:16px;">${esc(password)}</strong></div>
    </div>
    ${loginUrl ? `
    <div style="text-align:center;margin:24px 0;">
      <a href="${esc(loginUrl)}" style="display:inline-block;background:linear-gradient(135deg,#7daa3d,#5e8030);color:white;text-decoration:none;padding:13px 34px;border-radius:10px;font-weight:bold;font-size:15px;letter-spacing:1px;">ログインページを開く</a>
    </div>` : ''}
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px;margin:20px 0;font-size:11px;color:#92400e;line-height:1.8;">
      <strong>ご注意:</strong><br/>
      ・以前のパスワードは使えなくなっています<br/>
      ・ログイン後、画面内の「利用者・登録者情報」→「パスワードの変更」から、ご自身のパスワードへの変更をおすすめします<br/>
      ・このメールは大切に保管し、第三者にお見せにならないでください
    </div>
    <p style="font-size:11px;color:#94a3b8;line-height:1.6;margin-top:20px;text-align:center;border-top:1px solid #e2e8f0;padding-top:14px;">
      ${esc(safeFacility)}${facilityPhone ? ` / TEL ${esc(facilityPhone)}` : ''}<br/>
      心当たりがない場合は事業所までご連絡ください
    </p>
  </div>
</body></html>
  `.trim();

  try {
    const toEntry = { email: to };
    if (toName && toName.trim()) toEntry.name = toName.trim();
    const payload = {
      sender: { email: senderEmail, name: safeFacility.slice(0, 50) },
      to: [toEntry],
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
      let parsed = null;
      try { parsed = JSON.parse(errText); } catch {}
      const brevoMsg = parsed?.message || parsed?.code || errText.slice(0, 300);
      return res.status(response.status).json({ error: `Brevo API エラー (${response.status})`, brevoMessage: brevoMsg });
    }
    const data = await response.json().catch(() => ({}));
    return res.status(200).json({ success: true, messageId: data?.messageId || null });
  } catch (e) {
    return res.status(500).json({ error: 'メール送信に失敗しました', detail: String(e).slice(0, 500) });
  }
}
