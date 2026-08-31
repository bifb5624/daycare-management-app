// Vercel Serverless Function: 家族/本人/ケアマネ アカウントの「パスワードを忘れた」メール自己リセット
// 環境変数: BREVO_API_KEY / BREVO_SENDER_EMAIL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (api/admin-reset.js と共通)
//
// POST /api/family-reset
//   { action:'request', username }                     → アカウントの登録メールにのみ6桁コードを送信(コードはサーバー保存・10分有効)
//   { action:'reset',   username, code, newPassword }  → コード照合(5回まで)→ password_hash 更新。
//                                                        同メール+同旧パスワードのリンクアカウントもまとめて更新(複数利用者切替を維持)
//
// ★ セキュリティ方針(2026-08-31 店舗決定):
//   ・コードは登録済みメールアドレス宛にのみ送る(宛先入力はさせない)
//   ・有効期限 10分 / 試行 5回まで(超過で無効化・再リクエスト必要)
//   ・ID不存在/メール未登録でも応答は同じ(アカウント列挙対策)
//   ・コード保存先は店舗 app_state の systemSettings.familyPwResets (adminAuth の自己リセットと同方式)
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// クライアント(src/lib/supabase.js の hashPassword)と同一: SHA-256('tsumugi_v1_' + password)
const hashPassword = (pw) => sha256('tsumugi_v1_' + String(pw || ''));
const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  const mu = u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***';
  const dp = d.split('.');
  return `${mu}@${dp[0][0]}***.${dp.slice(1).join('.')}`;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA_URL || !SERVICE_KEY) return res.status(500).json({ error: 'サーバー設定エラー: Supabase の環境変数が未設定です' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { action } = body;
  const username = String(body.username || '').trim();
  if (!username) return res.status(400).json({ error: 'ログインIDを入力してください' });

  const supa = createClient(SUPA_URL, SERVICE_KEY);

  // アカウント検索 (削除済み除外)
  let acc = null;
  try {
    const r = await supa.from('family_accounts').select('*').eq('username', username).is('deleted_at', null).maybeSingle();
    if (r.error) throw r.error;
    acc = r.data;
  } catch (e) {
    return res.status(500).json({ error: 'アカウントの確認に失敗しました', detail: String(e.message || e) });
  }

  // 店舗 app_state の読み書きヘルパー
  const loadStore = async (storeId) => {
    const r = await supa.from('app_state').select('data').eq('key', String(storeId)).maybeSingle();
    if (r.error) throw r.error;
    return r.data ? (r.data.data || {}) : null;
  };
  const saveResets = async (storeId, data, resets) => {
    const ss = data.systemSettings || {};
    const newData = { ...data, systemSettings: { ...ss, familyPwResets: resets } };
    const u = await supa.from('app_state').update({ data: newData }).eq('key', String(storeId));
    if (u.error) throw u.error;
  };

  if (action === 'request') {
    // ★ ダブルチェック(2026-09-01 店舗決定): ログインIDに加えメールアドレスも入力させ、登録メールと一致した場合のみ送信。
    //   ID不存在・メール未登録・メール不一致・店舗不明でも同じ応答(列挙対策・実際には送らない)
    const inputEmail = String(body.email || '').trim().toLowerCase();
    if (!inputEmail) return res.status(400).json({ error: 'メールアドレスを入力してください' });
    if (!acc || !acc.email || !acc.store_id) return res.status(200).json({ ok: true });
    if (inputEmail !== String(acc.email).trim().toLowerCase()) return res.status(200).json({ ok: true });
    let data;
    try { data = await loadStore(acc.store_id); } catch { return res.status(200).json({ ok: true }); }
    if (!data) return res.status(200).json({ ok: true });
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6桁
    const resets = { ...((data.systemSettings || {}).familyPwResets || {}) };
    // 期限切れの残骸を掃除
    Object.keys(resets).forEach(k => { if (!resets[k] || Date.now() > Number(resets[k].exp)) delete resets[k]; });
    resets[String(acc.id)] = { h: sha256(code), exp: Date.now() + 10 * 60 * 1000, tries: 0 };
    try { await saveResets(acc.store_id, data, resets); } catch (e) {
      return res.status(500).json({ error: 'リセット情報の保存に失敗しました', detail: String(e.message || e) });
    }
    // メール送信 (Brevo)
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@ones-style.co.jp';
    if (apiKey) {
      const facility = (data.systemSettings || {}).facilityInfo?.name || 'デイサービス';
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const htmlBody = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif;background:#f4f8ed;margin:0;padding:24px;color:#1e293b;">
  <div style="max-width:520px;margin:0 auto;background:white;border-radius:14px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="text-align:center;border-bottom:2px solid #94c456;padding-bottom:14px;margin-bottom:18px;">
      <div style="font-size:13px;color:#5e8030;font-weight:bold;letter-spacing:2px;">${esc(facility)}</div>
      <div style="font-size:19px;color:#3d5021;font-weight:bold;margin-top:6px;">パスワード再設定コード</div>
    </div>
    <p style="font-size:14px;line-height:1.8;">${acc.display_name ? `<b>${esc(acc.display_name)} 様</b><br/>` : ''}ログインID「<b>${esc(username)}</b>」のパスワード再設定がリクエストされました。下記の<b>確認コード</b>を画面に入力してください。</p>
    <div style="text-align:center;margin:22px 0;">
      <div style="display:inline-block;font-size:32px;font-weight:bold;letter-spacing:10px;background:#f1f5f9;border:2px solid #94c456;border-radius:12px;padding:14px 26px;color:#1e293b;">${code}</div>
    </div>
    <p style="font-size:12px;color:#64748b;line-height:1.7;">・このコードの有効期限は<b>10分</b>です。入力を5回間違えると無効になります。<br/>・心当たりがない場合は、このメールを破棄してください（パスワードは変更されません）。</p>
  </div>
</body></html>`.trim();
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify({ sender: { email: senderEmail, name: facility.slice(0, 50) }, to: [{ email: acc.email }], subject: `【${facility}】パスワード再設定コード`.slice(0, 100), htmlContent: htmlBody }),
        });
      } catch (e) { /* コードは保存済み。 メール失敗は致命的にしない */ }
    }
    return res.status(200).json({ ok: true, masked: maskEmail(acc.email) });
  }

  if (action === 'reset') {
    const code = String(body.code || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!code || !newPassword) return res.status(400).json({ error: '確認コードと新しいパスワードは必須です' });
    if (newPassword.length < 6 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: '新しいパスワードは英字と数字を含む6文字以上にしてください' });
    }
    if (!acc || !acc.store_id) return res.status(400).json({ error: 'リセットがリクエストされていません。最初からやり直してください。' });
    let data;
    try { data = await loadStore(acc.store_id); } catch (e) { return res.status(500).json({ error: '店舗データの読込に失敗しました' }); }
    const resets = { ...(((data || {}).systemSettings || {}).familyPwResets || {}) };
    const st = resets[String(acc.id)];
    if (!st) return res.status(400).json({ error: 'リセットがリクエストされていません。最初からやり直してください。' });
    if (Date.now() > Number(st.exp)) { delete resets[String(acc.id)]; try { await saveResets(acc.store_id, data, resets); } catch {} return res.status(400).json({ error: 'コードの有効期限(10分)が切れています。最初からやり直してください。' }); }
    if (Number(st.tries || 0) >= 5) { delete resets[String(acc.id)]; try { await saveResets(acc.store_id, data, resets); } catch {} return res.status(400).json({ error: '試行回数の上限(5回)を超えました。最初からやり直してください。' }); }
    if (sha256(code) !== st.h) {
      resets[String(acc.id)] = { ...st, tries: Number(st.tries || 0) + 1 };
      try { await saveResets(acc.store_id, data, resets); } catch {}
      const left = 5 - Number(resets[String(acc.id)].tries);
      return res.status(400).json({ error: `確認コードが違います。${left > 0 ? `(あと${left}回入力できます)` : '試行回数の上限を超えました。最初からやり直してください。'}` });
    }
    // 照合OK → パスワード更新。 同メール+同旧ハッシュのリンクアカウントもまとめて更新(複数利用者切替を維持)
    const oldHash = acc.password_hash;
    const newHash = hashPassword(newPassword);
    try {
      const u1 = await supa.from('family_accounts').update({ password_hash: newHash }).eq('id', acc.id);
      if (u1.error) throw u1.error;
      if (acc.email && oldHash) {
        await supa.from('family_accounts').update({ password_hash: newHash })
          .eq('email', acc.email).eq('password_hash', oldHash).is('deleted_at', null);
      }
    } catch (e) {
      return res.status(500).json({ error: 'パスワードの保存に失敗しました', detail: String(e.message || e) });
    }
    delete resets[String(acc.id)];
    try { await saveResets(acc.store_id, data, resets); } catch {}
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: '不明な action です' });
}
