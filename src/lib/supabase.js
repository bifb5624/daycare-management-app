// Supabase クライアント (Phase 1: 家族認証のみ)
// 環境変数が設定されていない場合は null を返し、呼び出し側で localStorage フォールバック
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = (url && key) ? createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}) : null;

export const isSupabaseEnabled = !!supabase;

// 簡易ハッシュ (SHA-256 + 固定ソルト)
// 本格運用では Argon2/bcrypt が望ましいが、ブラウザ完結のため SHA-256 + ソルト
export async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = 'tsumugi_v1_'; // 注: 本格運用では per-user ソルト推奨
  const data = enc.encode(salt + (password || ''));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// =========================================================
// 招待発行 (スタッフ側 / 親アカウント側で呼び出し)
// =========================================================
export async function supabaseCreateInvite(invite) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('family_invites')
      .insert({
        patient_id: String(invite.patientId || ''),
        store_id: invite.storeId || null,  // ★ 家族側がこの店舗の app_state を pull できるよう必須
        code: invite.code,
        email: invite.email || null,
        relation: invite.relation || null,
        facility_name: invite.facilityName || null,
        patient_name: invite.patientName || null,
        facility_phone: invite.facilityPhone || null,
        expires_at: invite.expiresAt || null,
      })
      .select()
      .maybeSingle();
    if (error) {
      console.warn('[supabase] createInvite error', error);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('[supabase] createInvite exception', e);
    return null;
  }
}

// =========================================================
// 招待コード検証 + 家族アカウント作成 (新規登録時)
// =========================================================
export async function supabaseSignupFamily({
  inviteCode, username, password, email, relation, displayName, kind, role,
  facilityName, patientName,
  inviteFallback, // {patientId, expiresAt} - Supabase に招待が無い場合 (旧版で作成された招待) のフォールバック
}) {
  if (!supabase) throw new Error('Supabase 未接続');
  // 1. 招待検索 (URL token から仮登録されているはず)
  const { data: inv, error: invErr } = await supabase
    .from('family_invites')
    .select('*')
    .eq('code', inviteCode)
    .maybeSingle();
  if (invErr) throw invErr;
  // 招待が Supabase に無い → URL token のフォールバックがあれば自動作成
  let invite = inv;
  if (!invite && inviteFallback?.patientId) {
    const { data: created, error: cErr } = await supabase
      .from('family_invites')
      .insert({
        patient_id: String(inviteFallback.patientId),
        code: inviteCode,
        email: email || null,
        relation: relation || null,
        facility_name: facilityName || null,
        patient_name: patientName || null,
        expires_at: inviteFallback.expiresAt || null,
      })
      .select()
      .single();
    if (cErr) throw cErr;
    invite = created;
  }
  if (!invite) throw new Error('招待コードが見つかりません');
  if (inv.used_by) throw new Error('この招待コードは既に使用済みです');
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
    throw new Error('招待コードの有効期限が切れています');
  }
  // 2. username 重複チェック
  const { data: uExists } = await supabase
    .from('family_accounts')
    .select('id').eq('username', username).maybeSingle();
  if (uExists) throw new Error('このログインIDは既に使用されています');
  // 3. メール重複は許容 (1 人で複数利用者を見るケース: 夫婦の子、複数利用者を担当するケアマネ等)
  //    別ユーザー名で同じメールアドレスで複数アカウント作成可能
  // (ログイン後にメール+パスワード一致するアカウントを集約して複数利用者を選択可能にする)
  // 4. 家族アカウント作成 (★ invite.store_id を継承 → 家族側で店舗データを pull できるように)
  const password_hash = await hashPassword(password);
  const { data: acc, error: accErr } = await supabase
    .from('family_accounts')
    .insert({
      patient_id: invite.patient_id,
      store_id: invite.store_id || null,
      username, password_hash,
      kind: kind || 'family',
      relation: relation || inv.relation || '',
      display_name: displayName || '',
      email: email || '',
      facility_name: facilityName || inv.facility_name || '',
      patient_name: patientName || inv.patient_name || '',
      role: role || 'member',
    })
    .select()
    .single();
  if (accErr) throw accErr;
  // 5. 招待を使用済み化
  await supabase
    .from('family_invites')
    .update({ used_by: acc.id, used_at: new Date().toISOString() })
    .eq('id', inv.id);
  return { account: acc, invite: inv };
}

// =========================================================
// ログイン
// =========================================================
export async function supabaseLoginFamily({ username, password }) {
  if (!supabase) throw new Error('Supabase 未接続');
  const password_hash = await hashPassword(password);
  const { data, error } = await supabase
    .from('family_accounts')
    .select('*')
    .eq('username', username)
    .eq('password_hash', password_hash)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('IDまたはパスワードが違います');
  // 最終ログイン更新
  await supabase
    .from('family_accounts')
    .update({ last_login: new Date().toISOString() })
    .eq('id', data.id);
  // ★ リンクアカウント検索: 同じメール + 同じパスワードハッシュのアカウント
  //   (夫婦の子、複数利用者担当ケアマネ等が複数利用者を 1 つのログインで閲覧可能)
  let linkedAccounts = [data];
  if (data.email) {
    const { data: others } = await supabase
      .from('family_accounts')
      .select('*')
      .eq('email', data.email)
      .eq('password_hash', password_hash)
      .is('deleted_at', null);
    if (others && others.length > 0) linkedAccounts = others;
  }
  return { ...data, linkedAccounts };
}

// =========================================================
// 招待コードから事前情報取得 (家族登録画面で URL token と合わせて使う)
// =========================================================
export async function supabaseGetInviteByCode(code) {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from('family_invites')
      .select('*')
      .eq('code', code)
      .maybeSingle();
    return data;
  } catch { return null; }
}

// 患者の招待 + 家族アカウント一覧を取得 (アカウント発行画面の自動更新用)
// ★ 必ず store_id でも絞り込む (別店舗の同じ patient_id の家族が混入するバグの修正)
export async function supabaseListInvitesAndAccountsForPatient(patientId, storeId) {
  if (!supabase) return { invites: [], accounts: [] };
  try {
    let invQ = supabase.from('family_invites').select('*').eq('patient_id', String(patientId));
    let accQ = supabase.from('family_accounts').select('*').eq('patient_id', String(patientId)).is('deleted_at', null);
    // ★ storeId が指定されていれば必ずフィルタ (別店舗の混入防止)
    if (storeId) {
      invQ = invQ.eq('store_id', storeId);
      accQ = accQ.eq('store_id', storeId);
    } else {
      // storeId 未指定の場合は安全のため空を返す (誤った全件取得を防止)
      console.warn('[supabase] listInvitesAndAccountsForPatient called without storeId — returning empty');
      return { invites: [], accounts: [] };
    }
    const [inv, acc] = await Promise.all([
      invQ.order('created_at', { ascending: false }),
      accQ.order('created_at', { ascending: false }),
    ]);
    return { invites: inv.data || [], accounts: acc.data || [] };
  } catch (e) {
    console.warn('[supabase] listInvitesAndAccountsForPatient failed', e);
    return { invites: [], accounts: [] };
  }
}

// =========================================================
// 患者IDから家族アカウント一覧 (親が他家族追加時の重複防止)
// =========================================================
export async function supabaseListFamilyByPatient(patientId) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('family_accounts')
      .select('*')
      .eq('patient_id', String(patientId))
      .is('deleted_at', null);
    return data || [];
  } catch { return []; }
}

// =========================================================
// appData 全体を Supabase に保存 (スタッフ側からの push)
// =========================================================
// パスワード等の機密は除外し、家族画面で必要な部分のみ送る
const APP_STATE_KEY = 'default';
const sanitizeForSync = (data) => {
  if (!data) return {};
  const { familyAccounts, familyInvites, ...rest } = data;
  // familyAccounts/Invites は別テーブルで管理しているので app_state からは除外
  // (重複保存を避けてサイズを抑える)
  return rest;
};

export async function supabaseSyncState(data) {
  if (!supabase) return false;
  try {
    const sanitized = sanitizeForSync(data);
    const { error } = await supabase
      .from('app_state')
      .update({ data: sanitized })
      .eq('key', APP_STATE_KEY);
    if (error) {
      console.warn('[supabase] syncState error', error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[supabase] syncState exception', e);
    return false;
  }
}

export async function supabaseLoadState() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('data, updated_at')
      .eq('key', APP_STATE_KEY)
      .maybeSingle();
    if (error) {
      console.warn('[supabase] loadState error', error);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('[supabase] loadState exception', e);
    return null;
  }
}

// 一定時間ごとに state を pull (家族画面で使う)
export function supabaseSubscribeState(onChange, intervalMs = 15000, storeId = APP_STATE_KEY) {
  if (!supabase) return () => {};
  let stopped = false;
  let lastUpdate = '';
  const tick = async () => {
    if (stopped) return;
    try {
      const row = await supabaseLoadStateForStore(storeId);
      if (row && row.updated_at !== lastUpdate) {
        lastUpdate = row.updated_at;
        onChange(row.data);
      }
    } catch {}
  };
  tick(); // 即時1回
  const timer = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}

// =========================================================
// 店舗ごとの app_state 保存・読込 (マルチテナント用)
// =========================================================
export async function supabaseSyncStateForStore(storeId, data) {
  if (!supabase || !storeId) return false;
  try {
    const sanitized = sanitizeForSync(data);
    // 行が無ければ作成
    await supabase.from('app_state').upsert({ key: storeId, data: sanitized });
    return true;
  } catch (e) {
    console.warn('[supabase] syncStateForStore exception', e);
    return false;
  }
}

export async function supabaseLoadStateForStore(storeId) {
  if (!supabase || !storeId) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('data, updated_at')
      .eq('key', storeId)
      .maybeSingle();
    if (error) {
      console.warn('[supabase] loadStateForStore error', error);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('[supabase] loadStateForStore exception', e);
    return null;
  }
}

// =========================================================
// システムお知らせ (本部 → 全店舗 / 個別店舗)
// =========================================================
export async function supabaseListSystemNotices(storeId) {
  if (!supabase) return [];
  try {
    const now = new Date().toISOString();
    let q = supabase
      .from('system_notices')
      .select('*')
      .lte('starts_at', now)
      .order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) { console.warn('[supabase] listSystemNotices error', error); return []; }
    // ends_at が NULL OR 未来 のみ表示
    const active = (data || []).filter(n => !n.ends_at || new Date(n.ends_at) > new Date(now));
    // 対象店舗フィルタ: target_store_id が NULL なら全店、storeId と一致するもの
    return active.filter(n => !n.target_store_id || n.target_store_id === storeId);
  } catch (e) {
    console.warn('[supabase] listSystemNotices exception', e);
    return [];
  }
}

export async function supabaseListAllSystemNotices() {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('system_notices')
      .select('*')
      .order('created_at', { ascending: false });
    return data || [];
  } catch { return []; }
}

export async function supabaseCreateSystemNotice({ title, body, targetStoreId, severity, startsAt, endsAt, createdBy }) {
  if (!supabase) throw new Error('Supabase 未接続');
  const { data, error } = await supabase
    .from('system_notices')
    .insert({
      title,
      body,
      target_store_id: targetStoreId || null,
      severity: severity || 'info',
      starts_at: startsAt || new Date().toISOString(),
      ends_at: endsAt || null,
      created_by: createdBy || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function supabaseDeleteSystemNotice(id) {
  if (!supabase) return false;
  try {
    await supabase.from('system_notices').delete().eq('id', id);
    return true;
  } catch { return false; }
}

// ★ 家族側から patient 1件だけを安全に update する
//   (家族側でデータ全体を push すると、staff の編集を上書きしてしまうため)
//   最新の app_state を取得 → 対象 patient を merge → 戻す
export async function supabaseMergePatientFromFamily(storeId, patientId, patientPatch) {
  if (!supabase || !storeId || !patientId) return false;
  try {
    const row = await supabaseLoadStateForStore(storeId);
    if (!row || !row.data) return false;
    const currentData = row.data;
    const patients = (currentData.patients || []).map(p => {
      if (String(p.id) !== String(patientId)) return p;
      // emergencyContacts は配列マージ (重複防止)
      let mergedContacts = p.emergencyContacts || [];
      if (patientPatch.emergencyContacts) {
        const incoming = patientPatch.emergencyContacts || [];
        incoming.forEach(c => {
          const dup = mergedContacts.some(ex =>
            (ex.name||'').trim() === (c.name||'').trim() &&
            (ex.relation||'').trim() === (c.relation||'').trim()
          );
          if (!dup) mergedContacts = [...mergedContacts, c];
        });
      }
      // それ以外のフィールドはマージ (空でない値だけ上書き)
      const filteredPatch = {};
      Object.keys(patientPatch).forEach(k => {
        if (k === 'emergencyContacts') return;
        const v = patientPatch[k];
        if (v !== undefined && v !== null && v !== '') filteredPatch[k] = v;
      });
      return { ...p, ...filteredPatch, emergencyContacts: mergedContacts };
    });
    const updatedData = { ...currentData, patients };
    await supabase.from('app_state').upsert({ key: storeId, data: updatedData });
    return true;
  } catch (e) {
    console.warn('[supabase] mergePatientFromFamily failed', e);
    return false;
  }
}

// =========================================================
// スタッフ認証 (本部管理者 / 店舗管理者 / 店舗スタッフ)
// =========================================================
export async function supabaseStaffLogin({ username, password }) {
  if (!supabase) throw new Error('Supabase 未接続');
  const password_hash = await hashPassword(password);
  const { data, error } = await supabase
    .from('staff')
    .select('*, stores(id, name, short_name)')
    .eq('username', username.trim())
    .eq('password_hash', password_hash)
    .eq('is_active', true)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('IDまたはパスワードが違います');
  await supabase
    .from('staff')
    .update({ last_login: new Date().toISOString() })
    .eq('id', data.id);
  return data;
}

export async function supabaseStaffChangePassword(staffId, newPassword) {
  if (!supabase) throw new Error('Supabase 未接続');
  const password_hash = await hashPassword(newPassword);
  const { error } = await supabase
    .from('staff')
    .update({ password_hash })
    .eq('id', staffId);
  if (error) throw error;
  return true;
}

// =========================================================
// 店舗マスタ
// =========================================================
export async function supabaseListStores() {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('stores')
      .select('*')
      .eq('status', 'active')
      .order('name');
    return data || [];
  } catch { return []; }
}

export async function supabaseCreateStore({ id, name, short_name, org_name, zip_code, address, phone, fax, email }) {
  if (!supabase) throw new Error('Supabase 未接続');
  const { data, error } = await supabase
    .from('stores')
    .insert({ id, name, short_name, org_name, zip_code, address, phone, fax, email })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 家族アカウント削除 (username 即時解放)
// ★ 利用者を削除する際に、その利用者の家族アカウント + 招待を Supabase から物理削除
//   (削除しないと、別の利用者が同じ patient_id を再利用したときに古い家族情報が漏洩する)
export async function supabaseDeletePatientFamily(storeId, patientId) {
  if (!supabase || !storeId || !patientId) return false;
  try {
    // 1. 該当 family_invites を削除 (store_id AND patient_id でフィルタ)
    await supabase
      .from('family_invites')
      .delete()
      .eq('store_id', storeId)
      .eq('patient_id', String(patientId));
    // 2. 該当 family_accounts を削除
    await supabase
      .from('family_accounts')
      .delete()
      .eq('store_id', storeId)
      .eq('patient_id', String(patientId));
    return true;
  } catch (e) {
    console.warn('[supabase] deletePatientFamily failed', e);
    return false;
  }
}

export async function supabaseDeleteFamilyAccount(accountId) {
  if (!supabase) return false;
  try {
    // 関連 invite の used_by を解除 (used_at を残しつつ参照は外す)
    await supabase.from('family_invites').update({ used_by: null }).eq('used_by', accountId);
    // アカウント自体を物理削除
    const { error } = await supabase.from('family_accounts').delete().eq('id', accountId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[supabase] deleteFamilyAccount failed', e);
    return false;
  }
}

export async function supabaseDeleteStore(storeId) {
  if (!supabase) throw new Error('Supabase 未接続');
  // ★ 関連する家族アカウント・招待を完全削除 (この店舗 store_id で紐づくもの)
  //   削除しないと: 別店舗 (同じ患者ID) で登録した家族と被って違う利用者の情報が漏洩する原因に
  await supabase.from('family_invites').delete().eq('store_id', storeId);
  await supabase.from('family_accounts').delete().eq('store_id', storeId);
  // 関連スタッフ削除
  await supabase.from('staff').delete().eq('store_id', storeId);
  // app_state 削除
  await supabase.from('app_state').delete().eq('key', storeId);
  // 店舗削除
  const { error } = await supabase.from('stores').delete().eq('id', storeId);
  if (error) throw error;
  return true;
}

export async function supabaseCreateStaff({ store_id, username, password, role, last_name, first_name, email, phone }) {
  if (!supabase) throw new Error('Supabase 未接続');
  const password_hash = await hashPassword(password);
  // 重複チェック
  const { data: exists } = await supabase.from('staff').select('id').eq('username', username).maybeSingle();
  if (exists) throw new Error('このログインIDは既に使用されています');
  const { data, error } = await supabase
    .from('staff')
    .insert({ store_id, username, password_hash, role, last_name, first_name, email, phone })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function supabaseListStaff(storeId = null) {
  if (!supabase) return [];
  try {
    let q = supabase.from('staff').select('*').is('deleted_at', null).order('created_at');
    if (storeId) q = q.eq('store_id', storeId);
    const { data } = await q;
    return data || [];
  } catch { return []; }
}
