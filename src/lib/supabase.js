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
// ★ 家族アカウントID(username)が全店舗で既に使われているか確認 (重複ログイン=取り違え防止)。
//   excludeId を渡すと、そのアカウント自身は重複扱いしない(編集時用)。
//   返り値: true=既に使われている / false=未使用 / null=確認できなかった(通信エラー等→安全側で発行は止める運用)
export async function supabaseFamilyUsernameExists(username, excludeId) {
  if (!supabase) return null;
  const u = String(username || '').trim();
  if (!u) return false;
  try {
    let q = supabase.from('family_accounts').select('id').eq('username', u).is('deleted_at', null).limit(2);
    const { data, error } = await q;
    if (error) return null;
    const rows = (data || []).filter(r => String(r.id) !== String(excludeId || ''));
    return rows.length > 0;
  } catch { return null; }
}

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
  // familyAccounts/Invites は別テーブル管理のため除外。 _sbStoreId は「そのデータがどの店舗のものか」を
  // メモリ上で示す目印なのでクラウドには保存しない(店舗間で持ち回って誤判定するのを防ぐ)。
  const { familyAccounts, familyInvites, _sbStoreId, ...rest } = data;
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
  // ★ 同一idのレコードを「フィールド単位」でマージ (提供記録・日誌の送迎など)。
  //   別端末で違う項目(例: PCで気分/次回時間、iPadで体温)を入力した時、 レコード全体で新しい方を
  //   採用すると片方が消える。 → 非空を優先し、両方非空で異なる時だけ _savedAt が新しい方を採る。
  //   オブジェクト値(exercises・送迎の pick/drop 等)は中身をキー単位で結合する。
  const _isEmptyVal = (v) => v == null || v === '';
  const mergeRecordFields = (a, b) => {
    if (!a) return b; if (!b) return a;
    const at = Number(a._savedAt) || 0, bt = Number(b._savedAt) || 0;
    const aNewer = at >= bt;
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach(k => {
      if (k === '_savedAt') return;
      const av = a[k], bv = b[k];
      // ★ 次回予定(nextDateOverride/nextTimeOverride)は「空欄=未設定(自動計算に任せる)」であり、
      //   「明示的な削除」と区別できない(1項目の保存でも記録全体の _savedAt が新しくなり、空欄も新しく見える)。
      //   別端末で入力済みの時間が、当端末の空欄保存で消える事故を防ぐため、非空を無条件優先する。
      if (k === 'nextDateOverride' || k === 'nextTimeOverride') {
        const ae = _isEmptyVal(av), be = _isEmptyVal(bv);
        if (ae && be) { out[k] = av; return; }
        if (ae !== be) { out[k] = ae ? bv : av; return; } // 非空を優先(空欄では消さない)
        out[k] = aNewer ? av : bv; // 両方入力あり → 新しい方
        return;
      }
      const aObj = av && typeof av === 'object' && !Array.isArray(av);
      const bObj = bv && typeof bv === 'object' && !Array.isArray(bv);
      if (aObj || bObj) {
        // ★ exercises 等のオブジェクト(=触った項目だけを保持)は、キー単位でマージ。
        //   新しい方が「明示的に空にした」項目(=キーはあるが空)は、より新しい場合クリアを反映する
        //   (○を消して保存→戻る問題の解消)。 触っていない項目はキー自体が無いので相手の値が残る。
        const ao = aObj ? av : {}, bo = bObj ? bv : {};
        const older = aNewer ? bo : ao, newer = aNewer ? ao : bo;
        const newerStrict = aNewer ? (at > bt) : (bt > at);
        const mo = { ...older };
        Object.keys(newer).forEach(kk => {
          if (!_isEmptyVal(newer[kk])) mo[kk] = newer[kk];        // 新しい方に値あり → 採用
          else if (newerStrict) mo[kk] = newer[kk];              // 新しい方が明示的に空にした → クリアを反映
          else if (!(kk in mo)) mo[kk] = newer[kk];              // それ以外は相手の値を維持
        });
        out[k] = mo; return;
      }
      // ★ スカラー(特記/気分理由 等): 片方が空・片方が非空のとき。
      //   従来は無条件で「非空」を優先していたため、特記を削除して保存しても古い値が復活して消せなかった。
      //   → 「新しい方が(strictlyに)空にした」= 明示的な削除 のときはクリアを反映する。
      //   それ以外(古い/同時刻の空 vs 非空)は、非空を維持して「空データが入力済みを消す」事故を防ぐ。
      const aEmpty = _isEmptyVal(av), bEmpty = _isEmptyVal(bv);
      if (aEmpty && bEmpty) { out[k] = av; return; }
      if (aEmpty !== bEmpty) {
        const newerIsEmpty = aNewer ? aEmpty : bEmpty;
        const newerStrict = aNewer ? (at > bt) : (bt > at);
        if (newerIsEmpty && newerStrict) { out[k] = aNewer ? av : bv; return; } // 新しい方が削除 → 反映
        out[k] = aEmpty ? bv : av; // それ以外は非空を維持
        return;
      }
      out[k] = aNewer ? av : bv; // 両方非空の競合 → 新しい方
    });
    out._savedAt = Math.max(at, bt);
    return out;
  };
  const mergeByIdFieldLevel = (localArr, cloudArr) => {
    const map = new Map();
    (Array.isArray(cloudArr) ? cloudArr : []).forEach(r => { if (r && r.id != null) map.set(String(r.id), r); });
    (Array.isArray(localArr) ? localArr : []).forEach(r => { if (r && r.id != null) { const ex = map.get(String(r.id)); map.set(String(r.id), ex ? mergeRecordFields(ex, r) : r); } });
    return [...map.values()];
  };
  // ★ 利用者マスタのフィールド補完マージ (端末間のデータ消失対策)。
  //   ローカル(編集端末)を基準にしつつ、ローカルで「空欄」の項目だけクラウドの値で補完する。
  //   → 別端末で運動メニュー(規定数値)・送迎時間を入力しても、古いスナップショットの端末が
  //     保存した際に上書き消去されるのを防ぐ。 ローカルに無い利用者は復活させない(=削除は保持)。
  const mergePatientBackfill = (lpArg, cpArg) => {
    if (!cpArg) return lpArg; if (!lpArg) return cpArg;
    // ★ 新しい方(_savedAt)を基準(lp)にし、古い方(cp)で空欄のみ補完する。
    //   これが無いと、古いスナップショットの端末が保存した際に、新しい端末で編集した
    //   「サービス提供内容」等が古い値へ巻き戻ってしまう。 _savedAt が無い旧データは
    //   従来どおりローカル(編集端末)基準 (後方互換)。
    const _lT = Number(lpArg._savedAt) || 0, _cT = Number(cpArg._savedAt) || 0;
    const lp = (_cT > _lT) ? cpArg : lpArg;   // 新しい方
    const cp = (_cT > _lT) ? lpArg : cpArg;   // 古い方(補完元)
    const out = { ...lp };
    out._savedAt = Math.max(_lT, _cT);
    // ★ 利用状態(status/pauseHistory)は statusUpdatedAt が新しい方を「まとめて」採用する。
    //   利用者フィールドには _savedAt が無く先勝ち/後勝ちが曖昧なため、古い端末の保存で
    //   「休止」が「利用中」に巻き戻る不具合が起きていた。 時刻の新しい状態を必ず優先する。
    const _lStatT = Number(lp.statusUpdatedAt) || 0, _cStatT = Number(cp.statusUpdatedAt) || 0;
    const _statusTimed = !!(_lStatT || _cStatT);
    if (_statusTimed) {
      const src = (_cStatT > _lStatT) ? cp : lp; // 同点/未設定はローカル優先
      out.status = src.status;
      out.pauseHistory = src.pauseHistory;
      out.statusUpdatedAt = Math.max(_lStatT, _cStatT);
    }
    const keys = new Set([...Object.keys(lp), ...Object.keys(cp)]);
    keys.forEach(k => {
      if (k === '_savedAt') return;
      // 状態は上で時刻優先で確定済みなら、下の汎用処理はスキップ
      if (_statusTimed && (k === 'status' || k === 'pauseHistory' || k === 'statusUpdatedAt')) return;
      const lv = lp[k], cv = cp[k];
      // ★ 書類(介護保険証/負担割合証)と更新ログ: 両端末の追加を失わないよう id 単位で和集合マージ。
      //   docUpdates は既読フラグ(readOffice/readCm)を両者で OR (どちらかが既読なら既読)。
      if (k === 'docInsurance' || k === 'docBurden' || k === 'docUpdates') {
        const la = Array.isArray(lv) ? lv : [], ca = Array.isArray(cv) ? cv : [];
        if (!la.length && !ca.length) return;
        const byId = new Map();
        ca.forEach(d => { if (d && d.id != null) byId.set(String(d.id), d); });
        la.forEach(d => {
          if (!d || d.id == null) return;
          const key = String(d.id), prev = byId.get(key);
          if (prev && k === 'docUpdates') byId.set(key, { ...prev, ...d, readOffice: !!(prev.readOffice || d.readOffice), readCm: !!(prev.readCm || d.readCm) });
          else byId.set(key, d);
        });
        out[k] = [...byId.values()];
        return;
      }
      // ★ scheduleAmPm(基本利用日)は「無し」も意図的な設定値。 index 単位の空欄補完をすると、
      //   ある曜日を「無し」にしても クラウドの旧値(AM/PM)で復活してしまう。 最後の編集(ローカル)を優先する。
      if (k === 'scheduleAmPm') { out[k] = (lv !== undefined) ? lv : cv; return; }
      const lObj = lv && typeof lv === 'object' && !Array.isArray(lv);
      const cObj = cv && typeof cv === 'object' && !Array.isArray(cv);
      // プレーンオブジェクト(plannedExercises 等): キー単位で「ローカル空欄のみクラウドで補完」
      if (lObj || cObj) {
        const lo = lObj ? lv : {}, co = cObj ? cv : {};
        const mo = { ...lo };
        Object.keys(co).forEach(kk => { if (_isEmptyVal(mo[kk]) && !_isEmptyVal(co[kk])) mo[kk] = co[kk]; });
        // ★ personalFile.assessment: 事業所/ケアマネ双方の編集を保持
        //   text は updatedAt が新しい方、files は id 単位で和集合。
        if (k === 'personalFile' && (lo.assessment || co.assessment)) {
          const la = lo.assessment || {}, ca = co.assessment || {};
          const byId = new Map();
          (ca.files || []).forEach(d => { if (d && d.id != null) byId.set(String(d.id), d); });
          (la.files || []).forEach(d => { if (d && d.id != null) byId.set(String(d.id), d); });
          const newer = (String(ca.updatedAt || '') > String(la.updatedAt || '')) ? ca : la;
          mo.assessment = { ...la, ...ca, ...newer, files: [...byId.values()] };
        }
        out[k] = mo; return;
      }
      // 配列: スカラー配列(pickupTimes/scheduleAmPm 等)は index 単位で空欄補完。 オブジェクト配列(履歴系)はローカル優先。
      if (Array.isArray(lv) || Array.isArray(cv)) {
        const la = Array.isArray(lv) ? lv : [], ca = Array.isArray(cv) ? cv : [];
        const bothScalar = la.every(x => x == null || typeof x !== 'object') && ca.every(x => x == null || typeof x !== 'object');
        if (bothScalar) {
          const n = Math.max(la.length, ca.length);
          const res = [];
          for (let i = 0; i < n; i++) { const a = la[i]; res[i] = !_isEmptyVal(a) ? a : (i < ca.length ? ca[i] : a); }
          out[k] = res; return;
        }
        out[k] = (lv !== undefined) ? lv : cv; return;
      }
      // スカラー: ローカルが空欄ならクラウドで補完 (それ以外はローカル維持)
      if (_isEmptyVal(lv) && !_isEmptyVal(cv)) out[k] = cv;
    });
    return out;
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
    const ARRAY_KEYS = ['ticketRecords','dailyLogs','monitoringRecords','fitnessRecords','initialReports','familyAnnouncements','familyPersonalAnnouncements','familyPhotos','kinouKeikakuRecords','seikatsuKinouRecords','kyomiKanshinRecords','tsushoKeikakuRecords','scheduleEvents'];
    // ★ 削除した記録の墓石(tombstone)を local+cloud で統合。 これが無いと「id単位の和集合マージ」で
    //   削除した記録がもう片方(クラウド)から復活してしまう。 墓石にあるidはマージ後に除外する。
    const localTomb = (localData && localData.deletedIds) || {};
    const cloudTomb = (cloud && cloud.deletedIds) || {};
    const mergedTomb = {};
    ARRAY_KEYS.forEach(k => { mergedTomb[k] = { ...(cloudTomb[k] || {}), ...(localTomb[k] || {}) }; });
    // ★ 利用者本体の墓石も local+cloud で統合 (削除した利用者を別端末の push で復活させない)。
    mergedTomb.patients = { ...(cloudTomb.patients || {}), ...(localTomb.patients || {}) };
    const merged = { ...localData, deletedIds: mergedTomb };
    // ★ 提供記録・日誌はフィールド単位でマージ (別端末で違う項目を入力しても消えない)。 他はid単位。
    const FIELD_MERGE_KEYS = new Set(['ticketRecords','dailyLogs']);
    ARRAY_KEYS.forEach(k => {
      const tomb = mergedTomb[k] || {};
      const arr = FIELD_MERGE_KEYS.has(k) ? mergeByIdFieldLevel(localData[k], cloud[k]) : mergeById(localData[k], cloud[k]);
      merged[k] = arr.filter(r => !(r && r.id != null && tomb[String(r.id)]));
    });
    // ★ 利用者マスタ: 端末間で運動メニュー(規定数値)・送迎時間などが消えないよう、
    //   ローカル基準で「空欄の項目だけ」クラウドの値で補完する (削除は保持: ローカルに無い利用者は復活させない)。
    if (Array.isArray(localData.patients)) {
      const cloudPatMap = new Map((Array.isArray(cloud.patients) ? cloud.patients : []).map(p => [String(p.id), p]));
      const _patTomb = mergedTomb.patients || {};
      merged.patients = localData.patients
        .filter(lp => !(lp && lp.id != null && _patTomb[String(lp.id)])) // ★ 墓石にある利用者は除外(復活防止)
        .map(lp => { if (!lp || lp.id == null) return lp; const cp = cloudPatMap.get(String(lp.id)); return cp ? mergePatientBackfill(lp, cp) : lp; });
    }
    // ★ systemSettings: 端末間で「新しい方(_updatedAt)」を丸ごと採用する。
    //   これが無いと、運動メニュー等の設定を別端末で追加しても、古い systemSettings を持つ端末が
    //   別の保存(日誌等)をした拍子に push で上書きし、数時間〜1日後に設定が消えてしまう。
    //   _updatedAt が無い(旧データ)場合は、消失防止のため主要な配列を id/名前 で union して両端末の追加を保持。
    {
      const ls = localData.systemSettings, cs = cloud.systemSettings;
      if (ls || cs) {
        const lt = Number(ls && ls._updatedAt) || 0, ct = Number(cs && cs._updatedAt) || 0;
        if (lt || ct) {
          const base = (lt >= ct) ? ls : cs;   // 新しい方をベースに丸ごと採用
          const other = (lt >= ct) ? cs : ls;  // 古い方
          const out = { ...base };
          // ★ ケアマネ事業所/担当者は「追加を失わない」よう新旧をユニオン(ベース優先)。
          //   CSV取込で追加したケアマネが、別端末の設定保存(より新しい_updatedAt・CSV分を持たない)で
          //   丸ごと上書きされて消える不具合を防ぐ。
          const unionBy = (keyFn, k) => {
            const a = Array.isArray(base && base[k]) ? base[k] : [], b = Array.isArray(other && other[k]) ? other[k] : [];
            if (!a.length && !b.length) return;
            const m = new Map();
            b.forEach(x => { const kk = keyFn(x); if (kk != null) m.set(kk, x); });
            a.forEach(x => { const kk = keyFn(x); if (kk != null) m.set(kk, x); }); // ベース優先で上書き
            out[k] = [...m.values()];
          };
          unionBy(o => (o && o.name != null) ? `off|${String(o.name).trim()}` : null, 'cmOffices');
          unionBy(o => (o && (o.office != null || o.name != null)) ? `cm|${String(o.office||'').trim()}|${String(o.name||'').trim()}` : null, 'careManagers');
          merged.systemSettings = out;
        } else if (ls && cs) {
          // timestamp 無し: フィールドはローカル優先。 ただし主要な設定配列は「多い方」を採用して追加消失を防ぐ。
          const out = { ...cs, ...ls };
          ['exerciseItems','individualExerciseItems','serviceItems','cmOffices','careManagers','massageTypes','fitnessItems','fitnessTargets'].forEach(k => {
            const la = Array.isArray(ls[k]) ? ls[k] : null, ca = Array.isArray(cs[k]) ? cs[k] : null;
            if (la && ca) out[k] = (ca.length > la.length) ? ca : la;
            else out[k] = la || ca || out[k];
          });
          merged.systemSettings = out;
        } else {
          merged.systemSettings = ls || cs;
        }
      }
    }
    // ★ 連絡帳設定(contactBookConfig=連絡事項/掲載期間/定型文)は「新しい方(_updatedAt)」を丸ごと採用。
    //   これが無いと、古い端末が別の保存をした拍子に連絡事項・掲載期間を巻き戻してしまう。
    {
      const lc = localData.contactBookConfig, cc = cloud.contactBookConfig;
      if (lc || cc) {
        const lt = Number(lc && lc._updatedAt) || 0, ct = Number(cc && cc._updatedAt) || 0;
        if (lt || ct) merged.contactBookConfig = (lt >= ct) ? lc : cc;
        else merged.contactBookConfig = lc || cc; // 旧データ(時刻なし)は従来どおりローカル優先
      }
    }
    // ★ 日誌(diaryLogs)は「日付_AMPM」キーのオブジェクト。 端末間で別々の日を編集しても消えないよう、
    //   キー単位で統合し、同じキーは _savedAt が新しい方(無ければ内容が多い方)を採用する。
    {
      const lLogs = (localData.diaryLogs && typeof localData.diaryLogs === 'object') ? localData.diaryLogs : null;
      const cLogs = (cloud.diaryLogs && typeof cloud.diaryLogs === 'object') ? cloud.diaryLogs : null;
      if (lLogs || cLogs) {
        const outLogs = { ...(cLogs || {}) };
        Object.keys(lLogs || {}).forEach(k => {
          const lv = lLogs[k], cv = (cLogs || {})[k];
          if (!cv) { outLogs[k] = lv; return; }
          const lt = Number(lv && lv._savedAt) || 0, ct = Number(cv && cv._savedAt) || 0;
          if (lt || ct) outLogs[k] = (lt >= ct) ? lv : cv;
          else outLogs[k] = (JSON.stringify(lv).length >= JSON.stringify(cv).length) ? lv : cv;
        });
        merged.diaryLogs = outLogs;
      }
    }
    // ★ 月別シフト(monthlyShifts)は { 月キー: { 利用者ID: シフト } } の入れ子。 端末間で別々の月/利用者を
    //   編集しても消えないよう、月→利用者 単位で統合する。 クラウドを土台に、ローカル(=編集端末)の利用者は
    //   ローカルを採用する。 appData は常にクラウド同期されておりローカルが最新のため、シフトの「削除」
    //   (振替の取り消し等)も正しく反映される(以前は「項目数が多い方」優先で、削除したシフトがクラウドから復活していた)。
    {
      const lMs = (localData.monthlyShifts && typeof localData.monthlyShifts === 'object') ? localData.monthlyShifts : null;
      const cMs = (cloud.monthlyShifts && typeof cloud.monthlyShifts === 'object') ? cloud.monthlyShifts : null;
      if (lMs || cMs) {
        // ★ 月間シフトも「新しい方(_msSavedAt)」を優先する。 これが無いと、古い端末が別の保存
        //   (提供記録等)をした拍子に、古い monthlyShifts で新しい端末の「振替」設定を消してしまう。
        //   端末単位ではなく「利用者×月」単位で判定: 双方にある利用者は新しい側を採用(削除も反映)、
        //   片方にしか無い利用者はその側を保持(別々の月/利用者の編集は両方残す)。
        const lMsT = Number(localData._msSavedAt) || 0, cMsT = Number(cloud._msSavedAt) || 0;
        const localNewer = lMsT >= cMsT; // 同点/未設定はローカル(編集端末)優先=従来動作
        const outMs = {};
        const monthKeys = new Set([...Object.keys(lMs || {}), ...Object.keys(cMs || {})]);
        monthKeys.forEach(mk => {
          const lm = (lMs && lMs[mk] && typeof lMs[mk] === 'object') ? lMs[mk] : {};
          const cm = (cMs && cMs[mk] && typeof cMs[mk] === 'object') ? cMs[mk] : {};
          const om = {};
          const pids = new Set([...Object.keys(lm), ...Object.keys(cm)]);
          pids.forEach(pid => {
            const hasL = Object.prototype.hasOwnProperty.call(lm, pid);
            const hasC = Object.prototype.hasOwnProperty.call(cm, pid);
            if (hasL && hasC) om[pid] = localNewer ? lm[pid] : cm[pid];
            else if (hasL) om[pid] = lm[pid];
            else om[pid] = cm[pid];
          });
          outMs[mk] = om;
        });
        merged.monthlyShifts = outMs;
        merged._msSavedAt = Math.max(lMsT, cMsT);
      }
    }
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
        // ★ 同一「患者+日付」が複数idに分かれていても、丸ごと片方を捨てずフィールド単位で統合する。
        //   (旧: score が高い方のレコードを採用 → 次回お迎え時間など score 対象外のフィールドが消えていた)
        best.set(k, mergeRecordFields(ex, r));
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
      // emergencyContacts は配列マージ (重複防止)。 ★ 墓石(_deletedEC: 事業所側で削除した連絡先)は復活させない
      const _ecKey = c => `${(c.name||'').trim()}|${(c.relation||'').trim()}|${(c.phone||'').trim()}|${(c.phoneMobile||'').trim()}`;
      // ★ ケアマネ由来の連絡先は緊急連絡先(家族)には一切残さない(事業所名/事業所電話/FAXを持つ or 続柄がケアマネ系)。
      //   これで「ケアマネが緊急連絡先に混入 → 削除しても復活」を根絶する。
      const _isCmC = c => !!(c && (c.cmOffice || c.officePhone || c.officeFax || /ケアマネ|介護支援|居宅/.test(String(c.relation||''))));
      const _ecTomb = new Set(p._deletedEC || []);
      let mergedContacts = (p.emergencyContacts || []).filter(c => !_ecTomb.has(_ecKey(c)) && !_isCmC(c));
      if (patientPatch.emergencyContacts) {
        const incoming = patientPatch.emergencyContacts || [];
        incoming.forEach(c => {
          if (_ecTomb.has(_ecKey(c))) return; // 削除済み(墓石)は追加しない
          if (_isCmC(c)) return;              // ケアマネは緊急連絡先に追加しない
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
      // ★ docUpdates(更新通知ログ)は id で和集合マージ → 家族/CMの操作を事業所へ確実に届ける(上書きで消さない)
      let mergedDocUpdates = Array.isArray(p.docUpdates) ? p.docUpdates : [];
      if (Array.isArray(patientPatch.docUpdates)) {
        const _seenDu = new Set(mergedDocUpdates.map(u => u && u.id));
        patientPatch.docUpdates.forEach(u => { if (u && u.id && !_seenDu.has(u.id)) { mergedDocUpdates = [...mergedDocUpdates, u]; _seenDu.add(u.id); } });
        mergedDocUpdates = mergedDocUpdates.slice(-50);
      }
      const filteredPatch = {};
      Object.keys(patientPatch).forEach(k => {
        if (k === 'emergencyContacts' || k === 'relatedParties' || k === 'docUpdates') return;
        const v = patientPatch[k];
        if (v === undefined || v === null || v === '') return;
        // 別人が代表フィールドを上書きしようとした場合のみスキップ (本人/初回はそのまま反映)
        if (FAMILY_PRIMARY.includes(k) && isDifferentPerson) return;
        filteredPatch[k] = v;
      });
      return { ...p, ...filteredPatch, emergencyContacts: mergedContacts2, relatedParties: mergedRelated, docUpdates: mergedDocUpdates };
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

// ★ 家族/ケアマネ側の操作(招待発行・新規登録など)を事業所へ「確実に」通知するための汎用プリミティブ。
//    patient.docUpdates に1件を id で和集合追記して upsert する。
//    (既存ログ・他端末の追記は温存し、同じ id は二重登録しない=冪等)。
export async function supabaseAppendDocUpdate(storeId, patientId, entry) {
  if (!supabase || !storeId || !patientId || !entry) return false;
  try {
    const row = await supabaseLoadStateForStore(storeId);
    if (!row || !row.data) return false;
    const currentData = row.data;
    const now = new Date().toISOString();
    const e = {
      id: entry.id || `du_${now}_${Math.round(Math.random() * 1e6)}`,
      at: entry.at || now,
      by: entry.by || 'family',
      byName: entry.byName || '',
      items: [...new Set(entry.items || [])],
      readOffice: false,
      readCm: true,
    };
    let matched = false, already = false;
    const patients = (currentData.patients || []).map(p => {
      if (String(p.id) !== String(patientId)) return p;
      matched = true;
      const log = Array.isArray(p.docUpdates) ? p.docUpdates : [];
      if (log.some(u => u && u.id === e.id)) { already = true; return p; } // 既に反映済み
      return { ...p, docUpdates: [...log, e].slice(-50) };
    });
    if (!matched || already) return matched; // 対象なし=false / 既反映=true (再送しない)
    await supabase.from('app_state').upsert({ key: storeId, data: { ...currentData, patients } });
    return true;
  } catch (err) {
    console.warn('[supabase] appendDocUpdate failed', err);
    return false;
  }
}

// ★ ケアマネ(関係者)画面から フェイスシート を更新 → 事業所側の personalFile.faceSheet に反映。
//   変更ごとに版(faceSheetHistory)を追加する。 personalFile の他の部分(ファイル等)は温存。
export async function supabaseMergeFaceSheetFromCM(storeId, patientId, faceSheet, meta = {}) {
  if (!supabase || !storeId || !patientId) return false;
  try {
    const row = await supabaseLoadStateForStore(storeId);
    if (!row || !row.data) return false;
    const currentData = row.data;
    const now = new Date().toISOString();
    const patients = (currentData.patients || []).map(p => {
      if (String(p.id) !== String(patientId)) return p;
      const pf = p.personalFile || {};
      const newFs = { ...(pf.faceSheet || {}), ...(faceSheet || {}), updatedAt: now, updatedBy: meta.updatedBy || 'ケアマネ' };
      const prevHist = Array.isArray(pf.faceSheetHistory) ? pf.faceSheetHistory : [];
      const version = ((prevHist[prevHist.length - 1] || {}).version || 0) + 1;
      const { genogramFiles, floorPlanFiles, pickupRouteFiles, ...textOnly } = newFs;
      const snapshot = { ...textOnly, _attachCounts: { genogram: (genogramFiles || []).length, floorPlan: (floorPlanFiles || []).length, pickupRoute: (pickupRouteFiles || []).length } };
      const hist = [...prevHist, { version, updatedAt: now, updatedBy: newFs.updatedBy, source: meta.source || 'caremanager', snapshot }].slice(-20);
      // 共有の更新ログにも記録 (事業所側バナーに「フェイスシート」更新を表示)
      const log = Array.isArray(p.docUpdates) ? p.docUpdates : [];
      const docUpdates = [...log, { id: `du_${now}_${Math.round(Math.random() * 1e6)}`, at: now, by: 'caremanager', byName: newFs.updatedBy, items: ['フェイスシート'], readOffice: false, readCm: true }].slice(-50);
      // ★ F1: フェイスシートの既往歴(kiou)を患者トップにもミラー(計画書/CSV/帳票が参照する source of truth)
      return { ...p, kiou: (newFs.kiou ?? p.kiou ?? ''), docUpdates, personalFile: { ...pf, faceSheet: newFs, faceSheetHistory: hist } };
    });
    await supabase.from('app_state').upsert({ key: storeId, data: { ...currentData, patients } });
    return true;
  } catch (e) { console.warn('[supabase] mergeFaceSheetFromCM failed', e); return false; }
}

// ★ ケアマネ(関係者)画面から 書類(介護保険証/負担割合証/アセスメント) を更新
//    → 事業所側 patient.docInsurance / docBurden / personalFile.assessment に「追記マージ」(既存は温存)。
//    → 変更内容を patient.docUpdates ログに記録(readOffice:false = 事業所側に新着通知)。
//    patch: { docInsurance?:[], docBurden?:[], assessmentText?:string, assessmentFiles?:[] }
//    meta: { byName }
export async function supabaseMergePatientDocsFromCM(storeId, patientId, patch = {}, meta = {}) {
  if (!supabase || !storeId || !patientId) return false;
  try {
    const row = await supabaseLoadStateForStore(storeId);
    if (!row || !row.data) return false;
    const currentData = row.data;
    const now = new Date().toISOString();
    const byName = meta.byName || 'ケアマネ';
    let changed = [];
    const patients = (currentData.patients || []).map(p => {
      if (String(p.id) !== String(patientId)) return p;
      const np = { ...p };
      const unionDocs = (key, incoming, label) => {
        if (!Array.isArray(incoming) || !incoming.length) return;
        const ex = Array.isArray(np[key]) ? np[key] : [];
        const ids = new Set(ex.map(d => String(d && d.id)));
        const add = incoming.filter(d => d && !ids.has(String(d.id)));
        if (add.length) { np[key] = [...ex, ...add]; changed.push(label); }
      };
      unionDocs('docInsurance', patch.docInsurance, '介護保険証');
      unionDocs('docBurden', patch.docBurden, '負担割合証');
      // 保険証・負担割合証の内容(介護度/認定有効期間/負担割合)を利用者マスタへ反映。 値変更は変更履歴にも記録。
      const m = patch.master || {};
      const nowDay = now.split('T')[0];
      const appendHist = (histKey, oldVal, newVal, from, to) => {
        const hist = Array.isArray(np[histKey]) ? [...np[histKey]] : [];
        const nv = newVal == null ? '' : String(newVal);
        if (!nv || String(oldVal || '') === nv) return hist;
        const f = from || nowDay;
        if (oldVal) {
          if (hist.length > 0 && !hist[hist.length - 1].to) hist[hist.length - 1] = { ...hist[hist.length - 1], to: f };
          else if (hist.length === 0) hist.push({ value: oldVal, from: null, to: f, note: '' });
        }
        hist.push({ value: nv, from: f, to: to || null, note: '' });
        return hist;
      };
      if (m.careLevel != null && m.careLevel !== '' && String(m.careLevel) !== String(np.careLevel || '')) {
        np.careLevelHistory = appendHist('careLevelHistory', np.careLevel, m.careLevel, (m.careLevelFrom || np.careLevelFrom), (m.careLevelTo || np.careLevelTo));
        np.careLevel = String(m.careLevel); changed.push('介護度');
      }
      if (m.careLevelFrom != null && m.careLevelFrom !== '' && String(m.careLevelFrom) !== String(np.careLevelFrom || '')) { np.careLevelFrom = String(m.careLevelFrom); changed.push('認定有効期間'); }
      if (m.careLevelTo != null && m.careLevelTo !== '' && String(m.careLevelTo) !== String(np.careLevelTo || '')) { np.careLevelTo = String(m.careLevelTo); changed.push('認定有効期間'); }
      if (m.costBurden != null && m.costBurden !== '' && String(m.costBurden) !== String(np.costBurden || '')) {
        np.costBurdenHistory = appendHist('costBurdenHistory', np.costBurden, m.costBurden, null, null);
        np.costBurden = String(m.costBurden); changed.push('負担割合');
      }
      const hasAsmtText = patch.assessmentText != null && String(patch.assessmentText) !== ((np.personalFile || {}).assessment || {}).text;
      const hasAsmtFiles = Array.isArray(patch.assessmentFiles) && patch.assessmentFiles.length;
      if (hasAsmtText || hasAsmtFiles) {
        const pf = np.personalFile || {};
        const asmt = { ...(pf.assessment || {}) };
        if (patch.assessmentText != null) asmt.text = String(patch.assessmentText);
        if (hasAsmtFiles) {
          const ex = Array.isArray(asmt.files) ? asmt.files : [];
          const ids = new Set(ex.map(d => String(d && d.id)));
          asmt.files = [...ex, ...patch.assessmentFiles.filter(d => d && !ids.has(String(d.id)))];
        }
        asmt.updatedAt = now; asmt.updatedBy = byName;
        np.personalFile = { ...pf, assessment: asmt };
        changed.push('アセスメントシート');
      }
      if (changed.length) {
        const items = [...new Set(changed)];
        const log = Array.isArray(np.docUpdates) ? np.docUpdates : [];
        np.docUpdates = [...log, { id: `du_${now}_${Math.round(Math.random() * 1e6)}`, at: now, by: 'caremanager', byName, items, readOffice: false, readCm: true }].slice(-50);
      }
      return np;
    });
    if (!changed.length) return true;
    await supabase.from('app_state').upsert({ key: storeId, data: { ...currentData, patients } });
    return true;
  } catch (e) { console.warn('[supabase] mergePatientDocsFromCM failed', e); return false; }
}

// ★ docUpdates の既読フラグだけを更新 (side='cm' → readCm:true / side='office' → readOffice:true)。
//   ケアマネ画面は全体stateをpushしないため、ここで対象店舗のデータを読み直して該当項目のみ更新。
export async function supabaseMarkDocUpdatesRead(storeId, patientId, side = 'cm') {
  if (!supabase || !storeId || !patientId) return false;
  try {
    const row = await supabaseLoadStateForStore(storeId);
    if (!row || !row.data) return false;
    const currentData = row.data;
    const flag = side === 'office' ? 'readOffice' : 'readCm';
    const patients = (currentData.patients || []).map(p => {
      if (String(p.id) !== String(patientId)) return p;
      const log = Array.isArray(p.docUpdates) ? p.docUpdates : [];
      if (!log.some(u => !u[flag])) return p;
      return { ...p, docUpdates: log.map(u => u[flag] ? u : { ...u, [flag]: true }) };
    });
    await supabase.from('app_state').upsert({ key: storeId, data: { ...currentData, patients } });
    return true;
  } catch (e) { console.warn('[supabase] markDocUpdatesRead failed', e); return false; }
}

// ★ 店舗の管理者パスワード(adminAuth)だけを安全に更新する。
//   対象店舗のクラウドデータを読み直し、systemSettings.adminAuth のみ変更して書き戻す。
//   → 店舗切替直後などに「別店舗の appData 全体」を誤って書き込む(=店舗間データ混在)のを防ぐ。
export async function supabaseSetStoreAdminAuth(storeId, authPatch) {
  if (!supabase || !storeId) return false;
  try {
    const row = await supabaseLoadStateForStore(storeId);
    const data = (row && row.data) ? row.data : {};
    const nextSettings = { ...(data.systemSettings || {}), adminAuth: { ...(data.systemSettings?.adminAuth || {}), ...(authPatch || {}), setAt: Date.now() } };
    await supabase.from('app_state').upsert({ key: storeId, data: { ...data, systemSettings: nextSettings } });
    return true;
  } catch (e) { console.warn('[supabase] setStoreAdminAuth failed', e); return false; }
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

export async function supabaseCreateStore({ id, name, short_name, org_name, zip_code, address, phone, fax, email, address_building }) {
  if (!supabase) throw new Error('Supabase 未接続');
  const base = { id, name, short_name, org_name, zip_code, address, phone, fax, email };
  const withBuilding = (address_building !== undefined && address_building !== null && address_building !== '')
    ? { ...base, address_building } : base;
  let { data, error } = await supabase.from('stores').insert(withBuilding).select().single();
  // ★ address_building 列がまだ無いDBでも店舗作成が失敗しないようフォールバック (14_add_store_address_building.sql 未適用時)
  if (error && withBuilding !== base && /address_building|column|schema/i.test(error.message || '')) {
    ({ data, error } = await supabase.from('stores').insert(base).select().single());
  }
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
