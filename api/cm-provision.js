// Vercel Serverless Function: ケアマネの担当利用者ぶん閲覧アカウントの自動付与(サーバー側・2026-09-03)
// 背景: クライアント(anonキー)からの複製insertがDB制約/RLSで失敗しうることが実地テストで判明したため、
//       ログイン時/起動時の自己付与はサービスロールキーで確実に行う。認証は「ID+パスワードの照合」。
// 環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (api/family-reset.js と共通)
//
// POST /api/cm-provision  { username, password }
//   → アカウント照合(kind=caremanager)→店舗app_stateから担当利用者を特定→不足分を復活/複製
//   → { ok:true, added, revived, desired, errors:[...] }
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPassword = (pw) => sha256('tsumugi_v1_' + String(pw || ''));
const nrm = (s) => String(s || '').normalize('NFKC').replace(/[\s　]/g, '');

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
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'ログインIDとパスワードは必須です' });

  const supa = createClient(SUPA_URL, SERVICE_KEY);
  const errors = [];
  try {
    // 1. アカウント照合(削除済み除外・パスワードハッシュ一致・ケアマネ種別のみ)
    const r = await supa.from('family_accounts').select('*').eq('username', username).is('deleted_at', null).maybeSingle();
    if (r.error) throw r.error;
    const acc = r.data;
    if (!acc || acc.password_hash !== hashPassword(password)) return res.status(401).json({ error: 'IDまたはパスワードが違います' });
    if (!(acc.kind === 'caremanager' || acc.relation === 'ケアマネージャー')) return res.status(200).json({ ok: true, added: 0, revived: 0, desired: 0 });
    if (!acc.store_id || !acc.email) return res.status(200).json({ ok: true, added: 0, revived: 0, desired: 0 });

    // 2. 店舗データから本人と担当利用者を特定(クライアント側 supabaseSelfProvisionCm と同一ロジック)
    const st = await supa.from('app_state').select('data').eq('key', String(acc.store_id)).maybeSingle();
    if (st.error) throw st.error;
    const data = st.data ? (st.data.data || {}) : {};
    const pats = Array.isArray(data.patients) ? data.patients : [];
    const cms = Array.isArray(data.systemSettings && data.systemSettings.careManagers) ? data.systemSettings.careManagers : [];
    const em = String(acc.email).toLowerCase();
    let person = cms.find(c => c && c.email && String(c.email).toLowerCase() === em) || null;
    if (!person) {
      const m = cms.filter(c => { const x = nrm(c && c.name), y = nrm(acc.display_name); return x && y && (x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)))); });
      if (m.length === 1) person = m[0];
    }
    if (!person) return res.status(200).json({ ok: true, added: 0, revived: 0, desired: 0, note: '担当者マスタで本人を特定できませんでした' });
    const desired = pats.filter(p => p && (p.status || '利用中') !== '退所済み' && nrm(p.cmOffice) === nrm(person.office) && nrm(p.cmName) === nrm(person.name));

    // 3. 既存アカウント(同店舗+同メール)と突き合わせて不足分を復活/複製
    const lr = await supa.from('family_accounts').select('*').eq('store_id', acc.store_id).eq('email', acc.email);
    if (lr.error) throw lr.error;
    const rows = lr.data || [];
    const mine = rows.filter(x => x.password_hash === acc.password_hash);
    let added = 0, revived = 0;
    for (const p of desired) {
      const pid = String(p.id);
      if (mine.some(x => String(x.patient_id) === pid && !x.deleted_at)) continue;
      const dead = mine.find(x => String(x.patient_id) === pid && x.deleted_at);
      if (dead) {
        const u = await supa.from('family_accounts').update({ deleted_at: null }).eq('id', dead.id);
        if (u.error) errors.push(`復活失敗(${pid}): ${u.error.message}`); else revived++;
        continue;
      }
      let uname = `${acc.username}-p${pid}`.slice(0, 64);
      if (rows.some(x => x.username === uname)) uname = `${acc.username}p${pid}${String(Date.now()).slice(-4)}`.slice(0, 64);
      const rowBase = {
        patient_id: pid, store_id: acc.store_id, username: uname, password_hash: acc.password_hash,
        kind: 'caremanager', relation: 'ケアマネージャー', display_name: acc.display_name || person.name || '',
        email: acc.email, facility_name: acc.facility_name || '', patient_name: p.name || '', role: 'member',
      };
      // 制約差異を吸収する多段再試行(role許容値→記号なしID→role列をdefaultに)
      const variants = [rowBase, { ...rowBase, username: uname.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64) }];
      { const v = { ...rowBase }; delete v.role; variants.push(v); }
      let done = false, lastErr = null;
      for (const v of variants) {
        const ins = await supa.from('family_accounts').insert(v);
        if (!ins.error) { done = true; break; }
        lastErr = ins.error.message || String(ins.error);
      }
      if (done) added++; else errors.push(`作成失敗(${pid}): ${lastErr}`);
    }
    return res.status(200).json({ ok: true, added, revived, desired: desired.length, errors });
  } catch (e) {
    return res.status(500).json({ error: '付与処理に失敗しました', detail: String(e.message || e), errors });
  }
}
