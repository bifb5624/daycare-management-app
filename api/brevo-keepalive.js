// Vercel Cron: Brevo APIキーのキープアライブ (2026-09-01 店舗要望)
// Brevoは「3ヶ月間使用されていないAPIキー」を自動で非アクティブ化するため、
// 2ヶ月おき(vercel.json の crons: 奇数月1日 06:00 JST)に自動でテストメールを送り、使用実績を作る。
// 環境変数: BREVO_API_KEY / BREVO_SENDER_EMAIL (既存と共通)
//           BREVO_KEEPALIVE_EMAIL (省略時 honbu@ones-style.co.jp)
//           CRON_SECRET (任意。設定するとVercel Cron以外からの実行を拒否)

export default async function handler(req, res) {
  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付けて呼び出す (CRON_SECRET 設定時)
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@ones-style.co.jp';
  const to = process.env.BREVO_KEEPALIVE_EMAIL || 'honbu@ones-style.co.jp';
  if (!apiKey) return res.status(500).json({ error: 'BREVO_API_KEY が設定されていません' });

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const stamp = `${now.getUTCFullYear()}年${now.getUTCMonth() + 1}月${now.getUTCDate()}日`;
  const htmlBody = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif;background:#f4f8ed;margin:0;padding:24px;color:#1e293b;">
  <div style="max-width:520px;margin:0 auto;background:white;border-radius:14px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="font-size:16px;font-weight:bold;color:#3d5021;margin-bottom:10px;">つむぎ: メール送信の定期テスト（自動送信）</div>
    <p style="font-size:13px;line-height:1.8;margin:8px 0;">
      ${stamp} の自動キープアライブ送信です。<br/>
      このメールが届いていれば、招待メール・パスワード再設定などのメール送信機能は正常です。<br/>
      BrevoのAPIキーが「3ヶ月未使用」で無効化されるのを防ぐため、2ヶ月おきに自動送信しています。
    </p>
    <p style="font-size:11px;color:#94a3b8;margin-top:14px;">対応は不要です。このままお捨ていただいて構いません。</p>
  </div>
</body></html>`.trim();

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: 'つむぎ 自動テスト' },
        to: [{ email: to }],
        subject: `【つむぎ】メール送信の定期テスト（${stamp}・自動）`,
        htmlContent: htmlBody,
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(response.status).json({ error: 'Brevo API エラー', detail: errText.slice(0, 300) });
    }
    const data = await response.json().catch(() => ({}));
    return res.status(200).json({ success: true, to, messageId: data?.messageId || null });
  } catch (e) {
    return res.status(500).json({ error: 'メール送信に失敗しました', detail: String(e).slice(0, 300) });
  }
}
