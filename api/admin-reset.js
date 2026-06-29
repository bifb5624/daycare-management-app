// Vercel Serverless Function: 管理者パスワードの「忘れた時のメール自己リセット」
// 環境変数:
//   BREVO_API_KEY               - Brevo の API キー
//   BREVO_SENDER_EMAIL          - 送信元メール (Brevo 認証済み)
//   SUPABASE_URL                - Supabase プロジェクトURL (= VITE_SUPABASE_URL でも可)
//   SUPABASE_SERVICE_ROLE_KEY   - Supabase の Service Role キー (RLSを越えて app_state を読み書き)
//
// POST /api/admin-reset
//   { action:'request', storeId, email }                 → 登録メールと一致すれば6桁コードをメール送信し、ハッシュを保存
//   { action:'reset',   storeId, code, newPasswordHash } → コードを照合し、新しい管理者PWハッシュを保存
//
// ★ コードはサーバーで生成・保存し、メールでだけ届く。 クライアントはコードを知らない(=本人確認になる)。
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA_URL || !SERVICE_KEY) return res.status(500).json({ error: 'サーバー設定エラー: Supabase の環境変数(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)が未設定です' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { action, storeId } = body;
  if (!storeId) return res.status(400).json({ error: 'storeId は必須です' });

  const supa = createClient(SUPA_URL, SERVICE_KEY);
  let row;
  try {
    const r = await supa.from('app_state').select('data').eq('key', String(storeId)).maybeSingle();
    if (r.error) throw r.error;
    row = r.data;
  } catch (e) {
    return res.status(500).json({ error: '店舗データの読込に失敗しました', detail: String(e.message||e) });
  }
  if (!row) return res.status(404).json({ error: '店舗データが見つかりません' });
  const data = row.data || {};
  const ss = data.systemSettings || {};
  const auth = ss.adminAuth || {};

  if (action === 'request') {
    const email = String(body.email || '').trim();
    if (!auth.email) return res.status(400).json({ error: '再設定用メールアドレスが登録されていません。管理者にご確認ください。' });
    // メール不一致は列挙対策で「送った風」に返す(実際は送らない)
    if (email.toLowerCase() !== String(auth.email).trim().toLowerCase()) {
      return res.status(200).json({ ok: true });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6桁
    const newData = { ...data, systemSettings: { ...ss, adminAuth: { ...auth, resetCodeHash: sha256(code), resetCodeExp: Date.now() + 15 * 60 * 1000 } } };
    try {
      const u = await supa.from('app_state').update({ data: newData }).eq('key', String(storeId));
      if (u.error) throw u.error;
    } catch (e) {
      return res.status(500).json({ error: 'リセット情報の保存に失敗しました', detail: String(e.message||e) });
    }
    // メール送信 (Brevo)
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@ones-style.co.jp';
    if (apiKey) {
      const facility = ss.facilityInfo?.name || 'デイサービス';
      const htmlBody = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif;background:#f4f8ed;margin:0;padding:24px;color:#1e293b;">
  <div style="max-width:520px;margin:0 auto;background:white;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="text-align:center;border-bottom:2px solid #94c456;padding-bottom:14px;margin-bottom:18px;">
      <div style="font-size:13px;color:#5e8030;font-weight:bold;letter-spacing:2px;">${facility}</div>
      <div style="font-size:19px;color:#3d5021;font-weight:bold;margin-top:6px;">管理者パスワード 再設定コード</div>
    </div>
    <p style="font-size:14px;line-height:1.8;">管理者パスワードの再設定がリクエストされました。下記の<b>確認コード</b>を入力してください。</p>
    <div style="text-align:center;margin:22px 0;">
      <div style="display:inline-block;font-size:32px;font-weight:bold;letter-spacing:10px;background:#f1f5f9;border:2px solid #94c456;border-radius:12px;padding:14px 26px;color:#1e293b;">${code}</div>
    </div>
    <p style="font-size:12px;color:#64748b;line-height:1.7;">・このコードの有効期限は<b>15分</b>です。<br/>・心当たりがない場合は、このメールを破棄してください（パスワードは変更されません）。</p>
  </div>
</body></html>`.trim();
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({ sender: { email: senderEmail, name: facility.slice(0,50) }, to: [{ email: auth.email }], subject: `【${facility}】管理者パスワード再設定コード`.slice(0,100), htmlContent: htmlBody }),
        });
      } catch (e) { /* メール送信失敗してもコードは保存済み。 致命的にしない */ }
    }
    return res.status(200).json({ ok: true });
  }

  if (action === 'reset') {
    const code = String(body.code || '').trim();
    const newPasswordHash = String(body.newPasswordHash || '');
    if (!code || !newPasswordHash) return res.status(400).json({ error: 'コードと新しいパスワードは必須です' });
    if (!auth.resetCodeHash || !auth.resetCodeExp) return res.status(400).json({ error: 'リセットがリクエストされていません。最初からやり直してください。' });
    if (Date.now() > Number(auth.resetCodeExp)) return res.status(400).json({ error: 'コードの有効期限が切れています。最初からやり直してください。' });
    if (sha256(code) !== auth.resetCodeHash) return res.status(400).json({ error: '確認コードが違います。' });
    const newAuth = { ...auth, passwordHash: newPasswordHash, setAt: Date.now() };
    delete newAuth.resetCodeHash; delete newAuth.resetCodeExp;
    const newData = { ...data, systemSettings: { ...ss, adminAuth: newAuth } };
    try {
      const u = await supa.from('app_state').update({ data: newData }).eq('key', String(storeId));
      if (u.error) throw u.error;
    } catch (e) {
      return res.status(500).json({ error: 'パスワードの保存に失敗しました', detail: String(e.message||e) });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: '不明な action です' });
}
