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

    // 3. 完全整合(2026-09-03): 付与だけでなく「担当から外れた分の失効」「基点行の付け替え」まで行い、
    //    ログイン時点で切替リストが現在の担当割当と正確に一致するようにする。
    const lr = await supa.from('family_accounts').select('*').eq('store_id', acc.store_id).eq('email', acc.email);
    if (lr.error) throw lr.error;
    const rows = lr.data || [];
    const mine = rows.filter(x => x.password_hash === acc.password_hash);
    const desiredIds = new Set(desired.map(p => String(p.id)));
    // 複製行の判定: 同メール内の別行のユーザー名+利用者idから機械生成された形か
    const isClone = (r) => rows.some(b => b.username && b.username !== r.username && (
      r.username === `${b.username}-p${r.patient_id}` || r.username === `${b.username}p${r.patient_id}` ||
      String(r.username).startsWith(`${b.username}-p${r.patient_id}-`)));
    let added = 0, revived = 0, stopped = 0, repointed = 0;
    const stop = async (id) => { const u = await supa.from('family_accounts').update({ deleted_at: new Date().toISOString() }).eq('id', id); if (u.error) errors.push(`停止失敗: ${u.error.message}`); else stopped++; };
    // 3a. 担当から外れた分の失効(複製行)と基点行の付け替え
    let liveMine = mine.filter(x => !x.deleted_at);
    for (const r of liveMine) {
      if (desiredIds.has(String(r.patient_id))) continue;
      if (String(r.id) === String(acc.id) || r.username === acc.username) {
        // ログインに使う基点行: 停止するとID自体が死ぬので、現担当の利用者へ付け替える(担当0なら停止)
        if (!desired.length) { await stop(r.id); continue; }
        const uncovered = desired.find(p => !liveMine.some(x => String(x.patient_id) === String(p.id) && String(x.id) !== String(r.id)));
        const tgt = uncovered || desired[0];
        const u = await supa.from('family_accounts').update({ patient_id: String(tgt.id), patient_name: tgt.name || '' }).eq('id', r.id);
        if (u.error) errors.push(`付け替え失敗: ${u.error.message}`);
        else { repointed++; r.patient_id = String(tgt.id);
          if (!uncovered) { const dup = liveMine.find(x => String(x.patient_id) === String(tgt.id) && String(x.id) !== String(r.id)); if (dup) { await stop(dup.id); dup.deleted_at = 'x'; } } }
      } else {
        await stop(r.id); r.deleted_at = 'x';
      }
    }
    liveMine = mine.filter(x => !x.deleted_at);
    // 3b. 不足分の付与(停止中の復活を優先・無ければ複製)
    for (const p of desired) {
      const pid = String(p.id);
      if (liveMine.some(x => String(x.patient_id) === pid)) continue;
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
    // 3c. 失効グループの掃除: 同メールで別パスワードのグループに「生きた基点行」が無ければ、その複製は
    //     旧認証情報の残骸(例: 削除済みテストアカウント由来の誤生成)なので停止する。
    const byHash = new Map();
    rows.filter(x => x.password_hash !== acc.password_hash && (x.kind === 'caremanager' || x.relation === 'ケアマネージャー')).forEach(x => {
      const k = String(x.password_hash || ''); if (!byHash.has(k)) byHash.set(k, []); byHash.get(k).push(x);
    });
    for (const grp of byHash.values()) {
      const liveG = grp.filter(x => !x.deleted_at);
      if (!liveG.length) continue;
      if (!liveG.some(x => !isClone(x))) { for (const x of liveG) await stop(x.id); }
    }
    return res.status(200).json({ ok: true, added, revived, stopped, repointed, desired: desired.length, errors });
  } catch (e) {
    return res.status(500).json({ error: '付与処理に失敗しました', detail: String(e.message || e), errors });
  }
}
