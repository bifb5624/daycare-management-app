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
        store_id: inviteFallback.storeId || null,  // ★ 店舗 ID を継承 (家族アカウントが正しい店舗に紐付くように)
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
  // ★ inv は元クエリ結果で、フォールバック作成時は null になりうる。
  //   used_by / expires_at の判定は実際に使う invite を見る (null 参照クラッシュ防止)。
  if (invite.used_by) throw new Error('この招待コードは既に使用済みです');
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    throw new Error('招待コードの有効期限が切れています');
  }
  // 2. username 重複チェック (★ 削除済みアカウントは除外 → 削除後に同じIDを再利用できる)
  const { data: uExists } = await supabase
    .from('family_accounts')
    .select('id').eq('username', username).is('deleted_at', null).maybeSingle();
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
      relation: relation || invite.relation || '',
      display_name: displayName || '',
      email: email || '',
      facility_name: facilityName || invite.facility_name || '',
      patient_name: patientName || invite.patient_name || '',
      role: role || 'member',
    })
    .select()
    .single();
  if (accErr) throw accErr;
  // 5. 招待を使用済み化
  await supabase
    .from('family_invites')
    .update({ used_by: acc.id, used_at: new Date().toISOString() })
    .eq('id', invite.id);
  return { account: acc, invite };
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

// ★ Realtime購読: 指定店舗(key=storeId)の app_state 行が変わった瞬間に onChange を呼ぶ。
//   同じ店舗の行だけを対象(filter)にするので、他店舗の変更では通知は来ない。
//   Supabase 管理画面で app_state テーブルの Realtime を有効化すると動作する
//   (未有効でもエラーにはならず、 ポーリングが保険として働く)。
//   戻り値は購読停止関数。
export function supabaseSubscribeStoreRealtime(storeId, onChange) {
  if (!supabase || !storeId) return () => {};
  let channel;
  try {
    channel = supabase
      .channel(`app_state_${storeId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_state', filter: `key=eq.${storeId}` },
        (payload) => { try { onChange && onChange(payload); } catch {} }
      )
      .subscribe();
  } catch (e) {
    console.warn('[supabase] realtime subscribe failed', e);
    return () => {};
  }
  return () => { try { if (channel) supabase.removeChannel(channel); } catch {} };
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

// ★ 記録単位でマージしてから保存 (複数端末の同時編集でデータが消えないように)。
//   read-modify-write: クラウド最新を取得 → 記録配列を id 単位で「新しい _savedAt 優先」で統合 → 保存。
//   別々の利用者/日付/項目を同時に編集しても、お互いの記録が消えない (同じ記録の同時編集だけ後勝ち)。
export async function supabaseMergeAndSyncStateForStore(storeId, localData) {
  if (!supabase || !storeId) return false;
  // id 単位マージ: 同じ id は _savedAt が新しい方を採用。 片方にしか無い id は残す。
  const mergeById = (localArr, cloudArr) => {
    const l = Array.isArray(localArr) ? localArr : [];
    const c = Array.isArray(cloudArr) ? cloudArr : [];
    const map = new Map();
    c.forEach(r => { if (r && r.id != null) map.set(String(r.id), r); });
    l.forEach(r => {
      if (!r || r.id == null) return;
      const k = String(r.id);
      const ex = map.get(k);
      // ローカルの方が新しい(または同点/未スタンプ)なら採用。 クラウドが明確に新しければ残す。
      if (!ex || (Number(r._savedAt) || 0) >= (Number(ex._savedAt) || 0)) map.set(k, r);
    });
    return [...map.values()];
  };
  try {
    let cloud = null;
    try { const row = await supabaseLoadStateForStore(storeId); cloud = row && row.data ? row.data : null; }
    catch (e) {
      // クラウドを読めない (通信エラー等) → 上書きで他端末のデータを消す危険があるので保存しない
      console.warn('[supabase] mergeAndSync: load failed, skip save', e);
      return false;
    }
    // クラウドが空(=新規店舗) ならそのまま保存
    if (!cloud || Object.keys(cloud).length === 0) {
      return await supabaseSyncStateForStore(storeId, localData);
    }
    // 記録系の配列は id 単位でマージ (どちらの端末の記録も残す)。
    // ※ patients/systemSettings は _savedAt が無く、 record 保存時に誤って古い内容で
    //   上書きする恐れがあるためマージ対象に含めない (= 従来どおり編集端末の値を採用)。
    const ARRAY_KEYS = ['ticketRecords','dailyLogs','monitoringRecords','fitnessRecords','initialReports','familyAnnouncements','familyPersonalAnnouncements','familyPhotos','kinouKeikakuRecords','seikatsuKinouRecords','kyomiKanshinRecords'];
    // ★ 削除した記録の墓石(tombstone)を local+cloud で統合。 これが無いと「id単位の和集合マージ」で
    //   削除した記録がもう片方(クラウド)から復活してしまう。 墓石にあるidはマージ後に除外する。
    const localTomb = (localData && localData.deletedIds) || {};
    const cloudTomb = (cloud && cloud.deletedIds) || {};
    const mergedTomb = {};
    ARRAY_KEYS.forEach(k => { mergedTomb[k] = { ...(cloudTomb[k] || {}), ...(localTomb[k] || {}) }; });
    const merged = { ...localData, deletedIds: mergedTomb };
    ARRAY_KEYS.forEach(k => {
      const tomb = mergedTomb[k] || {};
      merged[k] = mergeById(localData[k], cloud[k]).filter(r => !(r && r.id != null && tomb[String(r.id)]));
    });
    // ★ ticketRecords は「患者+日付」で必ず1件に正規化。 旧ランダムid×新決定idの重複や、
    //   空欄の記録が入力済みの記録を上書きするのを防ぐ。 データが多い方(同点なら新しい方)を残す。
    if (Array.isArray(merged.ticketRecords)) {
      const keyOf = (r) => `${r.patientId}|${r.date}|${r.year||''}`;
      const FIELDS = ['temp_AM','temp_PM','bpUpSt_AM','bpUpSt_PM','bpDnSt_AM','bpDnSt_PM','plSt_AM','plSt_PM','bpUpEn_AM','bpUpEn_PM','bpDnEn_AM','bpDnEn_PM','plEn_AM','plEn_PM','massage','tokki','kibunArrival','kibunDeparture','actualTime'];
      const score = (r) => { let s=0; FIELDS.forEach(f=>{ if(r && r[f]) s++; }); if(r && r.exercises && Object.keys(r.exercises).length) s+=Object.keys(r.exercises).length; if(r && r.status && r.status!=='出席') s+=1; return s; };
      const best = new Map();
      merged.ticketRecords.forEach(r => {
        if (!r || r.patientId == null || !r.date) return;
        const k = keyOf(r); const ex = best.get(k);
        if (!ex) { best.set(k, r); return; }
        const rs = score(r), es = score(ex);
        if (rs > es || (rs === es && (Number(r._savedAt)||0) >= (Number(ex._savedAt)||0))) best.set(k, r);
      });
      merged.ticketRecords = [...best.values()];
    }
    return await supabaseSyncStateForStore(storeId, merged);
  } catch (e) {
    console.warn('[supabase] mergeAndSync exception', e);
    return false;
  }
}

export async function supabaseLoadStateForStore(storeId) {
  if (!supabase || !storeId) return null;
  // ★ 重要: 通信エラー (529 Overloaded / ネットワーク断 / RLS) のときは null を返さず必ず throw する。
  //   null を返すと呼び出し側が「行が無い = 新規店舗」と誤認し、空(BLANK)データで
  //   既存のクラウドデータを上書き消去してしまう (データ消失バグの原因)。
  //   「行が本当に無い (新規店舗)」場合のみ data=null を返す (maybeSingle は error=null)。
  const { data, error } = await supabase
    .from('app_state')
    .select('data, updated_at')
    .eq('key', storeId)
    .maybeSingle();
  if (error) {
    console.warn('[supabase] loadStateForStore error', error);
    throw new Error('loadStateForStore failed: ' + (error.message || error.code || 'unknown'));
  }
  return data; // 行が無ければ null (= 真の新規店舗)。 それ以外は { data, updated_at }
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
    // ★ 対象店舗フィルタ:
    //   - target_store_ids が null OR 空配列 → 全店共通
    //   - target_store_ids 配列に storeId 含まれる → 対象
    //   - 後方互換: target_store_id (旧 単一) も維持
    return active.filter(n => {
      const ids = Array.isArray(n.target_store_ids) ? n.target_store_ids : null;
      if (ids && ids.length > 0) return ids.includes(storeId);
      if (n.target_store_id) return n.target_store_id === storeId;
      return true; // 全店共通
    });
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

export async function supabaseCreateSystemNotice({ title, body, targetStoreIds, severity, startsAt, endsAt, createdBy }) {
  if (!supabase) throw new Error('Supabase 未接続');
  // ★ targetStoreIds: 配列 (空 or null → 全店)
  const ids = Array.isArray(targetStoreIds) && targetStoreIds.length > 0 ? targetStoreIds : null;
  const { data, error } = await supabase
    .from('system_notices')
    .insert({
      title,
      body,
      target_store_ids: ids,
      target_store_id: ids && ids.length === 1 ? ids[0] : null, // 単一なら旧カラムも埋める (後方互換)
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
export async function supabaseMergePatientFromFamily(storeId, patientId, patientPatch, extra) {
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
      // relatedParties (その他関係者) も配列マージ (同名+同事業所は重複防止)
      let mergedRelated = p.relatedParties || [];
      if (patientPatch.relatedParties) {
        (patientPatch.relatedParties || []).forEach(c => {
          const dup = mergedRelated.some(ex =>
            (ex.name||'').trim() === (c.name||'').trim() &&
            (ex.office||'').trim() === (c.office||'').trim()
          );
          if (!dup) mergedRelated = [...mergedRelated, c];
        });
      }
      // ★ 代表家族(familyName 等)の扱い:
      //   - クラウドに代表が居らず or 「同一人物(familyName 一致)の更新」 → そのまま反映 (代表が自分の情報を編集できる)
      //   - クラウドに代表が居て「別人」が代表を上書きしようとした場合のみ → 上書きせず emergencyContacts へ追加
      //   (2人目の家族登録で代表が最新の人に化ける不具合の対策。 かつ代表本人の編集はブロックしない)
      const FAMILY_PRIMARY = ['familyName','familyLastName','familyFirstName','familyKana','familyKanaLast','familyKanaFirst','familyRelation','familyPhone','familyPhoneMobile','familyEmail'];
      const cloudName = String(p.familyName||'').trim();
      const cloudHasPrimary = !!cloudName;
      const incName = String(patientPatch.familyName||'').trim();
      // 代表フィールドを含むパッチか
      const patchHasPrimary = FAMILY_PRIMARY.some(k => patientPatch[k] !== undefined && patientPatch[k] !== null && patientPatch[k] !== '');
      // 別人による代表の上書きか (代表が居て、 名前が入っていて、 既存代表と違う)
      const isDifferentPerson = cloudHasPrimary && patchHasPrimary && incName && incName !== cloudName;
      let mergedContacts2 = mergedContacts;
      if (isDifferentPerson) {
        const incRel = String(patientPatch.familyRelation||'').trim();
        const dup2 = mergedContacts2.some(c => (c.name||'').trim() === incName && (c.relation||'').trim() === incRel);
        if (incName && !dup2) {
          mergedContacts2 = [...mergedContacts2, { name: incName, relation: incRel, phone: patientPatch.familyPhone||'', phoneMobile: patientPatch.familyPhoneMobile||'', email: patientPatch.familyEmail||'' }];
        }
      }
      const filteredPatch = {};
      Object.keys(patientPatch).forEach(k => {
        if (k === 'emergencyContacts' || k === 'relatedParties') return;
        const v = patientPatch[k];
        if (v === undefined || v === null || v === '') return;
        // 別人が代表フィールドを上書きしようとした場合のみスキップ (本人/初回はそのまま反映)
        if (FAMILY_PRIMARY.includes(k) && isDifferentPerson) return;
        filteredPatch[k] = v;
      });
      return { ...p, ...filteredPatch, emergencyContacts: mergedContacts2, relatedParties: mergedRelated };
    });
    // ★ ケアマネ事業所/担当者マスタ (systemSettings) も、家族(関係者)登録で増えた分を統合 (重複は追加しない)
    let nextSettings = currentData.systemSettings || {};
    if (extra && (extra.cmOffices || extra.careManagers)) {
      nextSettings = { ...nextSettings };
      if (Array.isArray(extra.cmOffices)) {
        const exist = nextSettings.cmOffices || [];
        const names = new Set(exist.map(o => (o.name||'').trim()));
        const add = extra.cmOffices.filter(o => o && o.name && !names.has((o.name||'').trim()));
        if (add.length) nextSettings.cmOffices = [...exist, ...add];
      }
      if (Array.isArray(extra.careManagers)) {
        const exist = nextSettings.careManagers || [];
        const key = c => `${(c.office||'').trim()}|${(c.name||'').trim()}`;
        const keys = new Set(exist.map(key));
        const add = extra.careManagers.filter(c => c && c.name && !keys.has(key(c)));
        if (add.length) nextSettings.careManagers = [...exist, ...add];
      }
    }
    const updatedData = { ...currentData, patients, systemSettings: nextSettings };
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

// ★ 家族/ケアマネ アカウントの更新 (ログインID(username)・パスワード 等を後から変更)。
//   username 変更時は重複チェック (削除済み除外・自分除外)。
export async function supabaseUpdateFamilyAccount(accountId, patch, opts = {}) {
  if (!supabase) throw new Error('Supabase 未接続');
  const fields = { ...(patch || {}) };
  // 行の特定: 通常は id。 ローカルidとSupabase idが食い違う場合に備え、旧username(matchUsername)でも特定可。
  const matchUsername = opts.matchUsername || null;
  if (fields.username) {
    const { data: dups } = await supabase
      .from('family_accounts')
      .select('id,username').eq('username', fields.username).is('deleted_at', null);
    const conflict = (dups || []).some(d => matchUsername ? (d.username !== matchUsername) : (String(d.id) !== String(accountId)));
    if (conflict) throw new Error('このログインIDは既に使用されています');
  }
  // パスワード変更があれば hash 化して password_hash に
  if (fields.password) { fields.password_hash = await hashPassword(fields.password); delete fields.password; }
  let upd = supabase.from('family_accounts').update(fields);
  upd = matchUsername ? upd.eq('username', matchUsername).is('deleted_at', null) : upd.eq('id', accountId);
  const { error } = await upd;
  if (error) throw error;
  return true;
}

// ★ 店舗情報の更新 (店舗ID以外の 店舗名/短縮名/法人名/住所/電話/FAX 等を後から編集)
export async function supabaseUpdateStore(id, patch) {
  if (!supabase || !id) throw new Error('店舗IDが必要です');
  // id は変更不可 (ログインや app_state のキーになっているため)。 patch から除外。
  const { id: _omit, ...fields } = patch || {};
  const { data, error } = await supabase
    .from('stores')
    .update(fields)
    .eq('id', id)
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
    // ★ 関連 invite を物理削除 (used_by の解除ではなく、 招待自体を削除して
    //    同じメールアドレス/コードでの再使用を阻害しないようにする)
    await supabase.from('family_invites').delete().eq('used_by', accountId);
    // アカウント自体を物理削除
    const { error } = await supabase.from('family_accounts').delete().eq('id', accountId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[supabase] deleteFamilyAccount failed', e);
    return false;
  }
}

// ★ 未使用招待の単独削除 (id 指定)
//   家族画面で「取消」を押したとき、 ローカルだけでなく Supabase 側も削除
export async function supabaseDeleteInvite(inviteId) {
  if (!supabase || !inviteId) return false;
  try {
    const { error } = await supabase.from('family_invites').delete().eq('id', inviteId);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[supabase] deleteInvite failed', e);
    return false;
  }
}

// ★ 招待コード指定の削除 (code 指定) — local の招待 id しかない場合の fallback
export async function supabaseDeleteInviteByCode(code) {
  if (!supabase || !code) return false;
  try {
    const { error } = await supabase.from('family_invites').delete().eq('code', code);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[supabase] deleteInviteByCode failed', e);
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

// =========================================================
// Storage: 個人ファイル等の画像/PDF を Supabase Storage に保存
//   ★ 事前に Supabase 側で公開バケット (PF_BUCKET) の作成と
//     anon ロールの INSERT/SELECT ポリシー設定が必要。
//   base64 を app_state(jsonb) に積むのをやめ、URL だけ保持する。
// =========================================================
export const PF_BUCKET = 'personal-files';

// Blob/File をアップロードして { path, url } を返す (失敗時 null)
export async function supabaseUploadFile(blob, opts = {}) {
  if (!supabase || !blob) return null;
  try {
    const contentType = opts.contentType || blob.type || 'application/octet-stream';
    // 拡張子推定
    let ext = '';
    if (opts.name && /\.[^.]+$/.test(opts.name)) ext = opts.name.match(/\.[^.]+$/)[0].toLowerCase();
    else if (/pdf/.test(contentType)) ext = '.pdf';
    else if (/png/.test(contentType)) ext = '.png';
    else if (/jpe?g/.test(contentType)) ext = '.jpg';
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const prefix = opts.prefix ? `${String(opts.prefix).replace(/^\/+|\/+$/g,'')}/` : '';
    const path = `${prefix}${rand}${ext}`;
    const { error } = await supabase.storage.from(PF_BUCKET).upload(path, blob, {
      contentType, upsert: false, cacheControl: '3600',
    });
    if (error) { console.warn('[storage] upload error', error?.message || error); return null; }
    const { data } = supabase.storage.from(PF_BUCKET).getPublicUrl(path);
    return { path, url: data?.publicUrl || '' };
  } catch (e) {
    console.warn('[storage] upload exception', e?.message || e);
    return null;
  }
}

// 公開バケット用: storagePath から公開URLを返す (同期・ポリシー不要)
export function supabaseGetPublicUrl(path) {
  if (!supabase || !path) return null;
  try {
    const { data } = supabase.storage.from(PF_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch { return null; }
}

// 非公開バケット用: storagePath から署名付きURL (時間制限) を発行
export async function supabaseGetSignedUrl(path, expiresIn = 900) {
  if (!supabase || !path) return null;
  try {
    const { data, error } = await supabase.storage.from(PF_BUCKET).createSignedUrl(path, expiresIn);
    if (error) { console.warn('[storage] signedUrl error', error?.message || error); return null; }
    return data?.signedUrl || null;
  } catch (e) {
    console.warn('[storage] signedUrl exception', e?.message || e);
    return null;
  }
}

// 指定プレフィックス(フォルダ)配下のファイルを全削除 (利用者完全削除時など)
export async function supabaseDeleteFolder(prefix) {
  if (!supabase || !prefix) return false;
  try {
    const clean = String(prefix).replace(/^\/+|\/+$/g, '');
    const { data: list, error } = await supabase.storage.from(PF_BUCKET).list(clean, { limit: 1000 });
    if (error) { console.warn('[storage] deleteFolder list error', error?.message || error); return false; }
    if (list && list.length) {
      const paths = list.filter(f => f.name).map(f => `${clean}/${f.name}`);
      if (paths.length) await supabase.storage.from(PF_BUCKET).remove(paths);
    }
    return true;
  } catch (e) {
    console.warn('[storage] deleteFolder exception', e?.message || e);
    return false;
  }
}

// Storage 上のファイルを削除 (path 指定)
export async function supabaseDeleteFile(path) {
  if (!supabase || !path) return false;
  try {
    const { error } = await supabase.storage.from(PF_BUCKET).remove([path]);
    if (error) { console.warn('[storage] delete error', error?.message || error); return false; }
    return true;
  } catch (e) {
    console.warn('[storage] delete exception', e?.message || e);
    return false;
  }
}
