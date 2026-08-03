// Supabase クライアント (Phase 1: 家族認証のみ)
// 環境変数が設定されていない場合は null を返し、呼び出し側で localStorage フォールバック
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = (url && key) ? createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}) : null;

export const isSupabaseEnabled = !!supabase;

// =========================================================
// ★ 同期用の単調時計 (Lamport clock)
//   同期のマージは全て「_savedAt / _fieldTs が新しい方を採用」で決めている。 ところが各端末の
//   Date.now() は端末の時計そのもので、PC と iPad で数十秒〜数分ズレることがある。
//   時計が遅れている端末は、進んでいる端末が書いた値に「永久に勝てない」→ 入力しても保存が
//   マージで捨てられ、画面上は同期が止まったように見え、再読み込みで入力が消える。
//   → クラウドに最大時刻(__clock)を1つ持たせ、読むたびに自分の時計をそれ以上へ進める。
//     これで「クラウドで見た最新より必ず新しい」時刻を刻めるので、時計ズレでは負けなくなる。
// ★ 同期の健全性。 「保存したのにクラウドへ届いていない」状態が画面に出ないまま続くのを防ぐ。
//   lastOkAt: 最後にクラウド保存が成功した時刻 / lastFailAt: 最後に失敗した時刻
export const syncHealth = { lastOkAt: 0, lastFailAt: 0, lastError: '' };

// ★ 同期の診断ログ (直近120件のリングバッファ)。 iPad ではコンソールが見られないため localStorage に残し、
//   ?syncdebug=1 で開いた時に画面から確認できるようにする。 原因調査用で通常運用には影響しない。
const _SYNCLOG_KEY = 'tsumugiSyncLog';
export function syncLog(ev, detail) {
  try {
    const arr = JSON.parse(localStorage.getItem(_SYNCLOG_KEY) || '[]');
    // ★ 端末のローカル時刻 + 連番。 連番が増えていれば「動いているが時計がずれている」、
    //   増えていなければ「本当に止まっている」と一目で区別できる。
    const d = new Date();
    const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0'), ss = String(d.getSeconds()).padStart(2,'0');
    arr.push({ t: `${hh}:${mm}:${ss}`, n: (arr.length ? (Number(arr[arr.length-1].n)||0) + 1 : 1), ev, d: detail || null });
    localStorage.setItem(_SYNCLOG_KEY, JSON.stringify(arr.slice(-120)));
  } catch {}
}
export function getSyncLog() { try { return JSON.parse(localStorage.getItem(_SYNCLOG_KEY) || '[]'); } catch { return []; } }
export function clearSyncLog() { try { localStorage.removeItem(_SYNCLOG_KEY); } catch {} }
// ★ 操作ログ方式へ移行済みのキー。 巨大JSON側では読み取り専用(スナップショット)として扱う。
export const OPLOG_FROZEN_KEYS = new Set(['ticketRecords']);  // ★プレビュー検証(preview-table2): 提供記録はテーブルが正・巨大JSON側は凍結(テーブルが読めた端末のみ)
// ★★ 自己検証つき切替【重要な安全装置】
//   凍結(巨大JSONへの保存を止めること)は、「この端末の操作ログが実際にサーバーへ届いた」ことを
//   確認できて初めて有効になる。 一度も届いていない間は従来どおり巨大JSONへ保存し続けるので、
//   操作ログが動かない環境でも保存先が無くなることは原理的に起きない。
//     writable : 送信が1回でも成功した(サーバーが採番を返した) → 凍結してよい
//     readable : 操作ログの読み取りに成功した → 受信した操作を画面へ反映してよい
export const oplogState = {
  // 起動直後から正しいモードで動けるよう、一度切り替わった事実は端末に残す。
  // (これが無いと、再読み込み直後の数秒だけ旧方式で動き、操作ログで復元した値が
  //  クラウドの古いスナップショットで上書きされて消える)
  writable: (() => { try { return localStorage.getItem('tsumugiOplogMode') === '1'; } catch { return false; } })(),
  readable: false,
  // ★ テーブル(ticket_records)の初回読込が「失敗した」ときだけ true。 true の間は凍結を解除し、
  //   従来の巨大JSON方式にフォールバックする(テーブルが読めない端末でも記録が流れ続けるように)。
  tableFailed: false,
};
export function markOplogWritable() {
  if (oplogState.writable) return;
  oplogState.writable = true;
  try { localStorage.setItem('tsumugiOplogMode', '1'); } catch {}
}
// ★ 凍結は「起動直後から」効かせる(テーブル読込の完了を待たない)。
//   旧実装(writable待ち)は、起動〜テーブル読込完了までの数秒間に巨大JSONへの書込/取込が走り、
//   7/30凍結時点の古いスナップショットが提供記録を丸ごと上書きする穴になっていた。
//   テーブル初回読込が失敗した端末だけ凍結を解除(tableFailed)し、従来方式で安全に継続する。
export const isOplogFrozen = (key) => OPLOG_FROZEN_KEYS.has(key) && !oplogState.tableFailed;
const _CLOCK_KEY = 'tsumugiClockOffset';
let _clockOffset = (() => { try { return Number(localStorage.getItem(_CLOCK_KEY)) || 0; } catch { return 0; } })();
// 同期用の現在時刻。 _savedAt / _fieldTs / _updatedAt は必ずこれを使う。
export function syncNow() { return Date.now() + _clockOffset; }
// ★ __clock 導入前のデータ対策: 記録に既に刻まれている最大時刻を拾う (時計が進んだ端末が書いた
//   未来の _savedAt に、遅れた端末が永久に勝てない状態を初回から解消するため)。
export function maxRecordClock(data) {
  let m = Number(data && data.__clock) || 0;
  if (!data) return m;
  ['ticketRecords','dailyLogs'].forEach(k => {
    const arr = data[k];
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) { const t = Number(arr[i] && arr[i]._savedAt) || 0; if (t > m) m = t; }
  });
  return m;
}
// クラウドで観測した最大時刻を取り込む (自分より進んでいたらオフセットを引き上げる)。
export function observeRemoteClock(t) {
  const rt = Number(t) || 0;
  if (!rt) return;
  // ★ 明らかに壊れた時刻(400日以上先)は取り込まない。 端末の時計が大きく狂ったまま書き込まれた
  //   データに全端末が引きずられて、以後ずっと未来の時刻を刻み続けるのを防ぐ。
  const need = rt - Date.now() + 1;
  if (need > 400 * 86400000) { console.warn('[sync] 異常な同期時刻を無視しました', new Date(rt).toISOString()); return; }
  if (need > _clockOffset) {
    _clockOffset = need;
    try { localStorage.setItem(_CLOCK_KEY, String(_clockOffset)); } catch {}
    console.warn('[sync] 端末の時計がクラウドより遅れていたため同期時刻を補正しました (+' + Math.round(need/1000) + '秒)');
    syncLog('clock-adjust', { sec: Math.round(need/1000) });
  }
}

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

// ★ レガシー単一テナント用 supabaseSyncState は削除(未使用・非CASの生update)。 マルチテナントは
//   supabaseMergeAndSyncStateForStore / supabaseSyncStateForStore(いずれもCAS経由)を使用する。

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
// ★ 楽観ロック(CAS)用のバックオフ: 指数バックオフ＋ジッター。
function _casBackoff(attempt) {
  const capBase = Math.min(1000, 80 * Math.pow(2, attempt)); // 80,160,320,640,1000...
  const jitter = Math.floor(Math.random() * capBase);
  return new Promise(r => setTimeout(r, capBase + jitter));
}
// ★ 楽観ロック(CAS): app_state への「全書き込みの単一入口」。 lost update(古いデータで新しいデータを上書き)を防ぐ。
//   mutate(currentData|null) は「保存したい新しい data」を返す純関数(副作用なし・冪等に書くこと)。
//   フロー: ①最新の {data, version} を取得 → ②mutate → ③『DB側で原子的に』 version 一致を条件に UPDATE
//     (UPDATE ... SET data=:next, version=version+1 WHERE key=:key AND version=:base)。
//   ★ 競合判定は「返り行0件」で行う(JS側で version を比較して書く構造にはしない)。 0件=他端末が先に更新済み
//     → バックオフして①から再取得・再mutate・再試行(最大 opts.maxRetries 回, 既定5)。 上限で {ok:false}。
//   ★ 応答ロス→再試行での二重適用は、呼び出し側 mutate を「ID冪等」にして防ぐ(同IDが既存なら追加しない)。
// ★ 同一店舗(key)のCAS書き込みを直列化(同時に1本だけ)。
//   主保存経路が「全715件push」を短時間に複数撃つと、それらが自分同士でCAS衝突し、
//   リトライ上限超過(conflict-retries-exhausted = push-fail)で保存が失敗していた(今回の凍結の直接原因)。
//   関門をここ1箇所に絞り、前のCASが完了してから次を実行することで自己衝突を根絶する。
//   各CASは実行時に最新versionを取り直して再mutateするので、直列化しても内容は最新・正しい。
const _casChain = new Map(); // key -> Promise(直近CASの完了)
async function supabaseCasUpdate(key, mutate, opts = {}) {
  if (!supabase || !key) return { ok: false, reason: 'no-supabase' };
  const prev = _casChain.get(key) || Promise.resolve();
  const next = prev.then(() => _casUpdateInner(key, mutate, opts),
                         () => _casUpdateInner(key, mutate, opts)); // 前が失敗しても次は必ず実行
  _casChain.set(key, next.catch(() => {}));   // 鎖として保持(未処理rejectを出さない)。呼び出し側へは next をそのまま返す
  return next;
}
async function _casUpdateInner(key, mutate, opts = {}) {
  if (!supabase || !key) return { ok: false, reason: 'no-supabase' };
  const MAX = (opts.maxRetries != null) ? opts.maxRetries : 5;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    // ① 最新の {data, version} を取得 (読めない=通信/RLSエラーは throw して呼び出し側で保存中止=既存データを守る)
    const { data: row, error: selErr } = await supabase
      .from('app_state').select('data, version').eq('key', key).maybeSingle();
    if (selErr) throw new Error('cas select failed: ' + (selErr.message || selErr.code || 'unknown'));
    if (!row) {
      // 行が無い=新規作成 (唯一の非CAS経路: version 0 で insert のみ。 version を巻き戻さない)。
      const initData = mutate(null);
      if (initData == null) return { ok: true, version: 0, noop: true };
      const { data: ins, error: insErr } = await supabase
        .from('app_state').insert({ key, data: initData, version: 0 }).select('version');
      if (!insErr && ins && ins.length) return { ok: true, data: initData, version: 0, created: true };
      // insert 失敗(別端末が同時に作成=一意制約) → 再取得して update 経路へ
      await _casBackoff(attempt); continue;
    }
    const base = Number(row.version) || 0;
    // ★ クラウドが持つ最大同期時刻を取り込んでから mutate する (時計が遅れた端末でも必ず勝てるようにする)
    observeRemoteClock(row.data && row.data.__clock ? row.data.__clock : maxRecordClock(row.data));
    const next = mutate(row.data || null);
    if (next == null) return { ok: true, version: base, noop: true };
    // ★ 書き込むデータに「この時点での最大同期時刻」を刻む (次に読む端末がこれ以上へ時計を進める)
    try { next.__clock = Math.max(Number(row.data && row.data.__clock) || 0, syncNow()); } catch {}
    // ② 原子的CAS: WHERE key AND version=base の1行だけ更新(version+1)。 返り行で成否判定。
    const { data: upd, error: updErr } = await supabase
      .from('app_state').update({ data: next, version: base + 1 })
      .eq('key', key).eq('version', base).select('version');
    if (updErr) throw new Error('cas update failed: ' + (updErr.message || updErr.code || 'unknown'));
    if (upd && upd.length > 0) return { ok: true, data: next, version: base + 1 };
    // ③ 0件=競合(他端末が先に version を進めた) → バックオフして再取得・再mutate・再試行
    syncLog('cas-conflict', { attempt, base });
    await _casBackoff(attempt);
  }
  return { ok: false, reason: 'conflict-retries-exhausted' };
}
// ★ 上書きCAS: 新規店舗のBLANK初期化 と 全データ一括初期化(リセット) の【2箇所専用】。
//   ★注意: この経路の再試行は「再マージ」ではなく『再上書き』= 競合時は他端末の同時編集を捨てる(意図的な全置換)。
//     通常の保存はここを通らない(マージ経路 supabaseMergeAndSyncStateForStore を使う)。
//   呼び出し元: (1) App.jsx 新規店舗BLANK初期化 (2) App.jsx 全データ一括初期化リセット の2箇所のみ。
export async function supabaseSyncStateForStore(storeId, data) {
  if (!supabase || !storeId) return false;
  try {
    const sanitized = sanitizeForSync(data);
    const res = await supabaseCasUpdate(storeId, () => sanitized); // mutate は cloud を無視して常に上書き
    return !!(res && res.ok);
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
  // ★ _fieldTs の「新しい方が空=意図的削除」判定から除外する項目。 これらは画面側が正規化/派生で空を書くため、
  //   除外しないと『別端末で入力済みの値』が空で消える(下の非空優先の保護に必ず委ねる)。
  const FIELDTS_EXCLUDE = new Set([
    'nextDateOverride','nextTimeOverride', // 空=未設定(自動計算)
    'actualTime',                          // 空=施設の既定提供時間を使う(専用の入力UIが無い)
    'temp','bpUpSt','bpDnSt','bpUpEn','bpDnEn','plSt','plEn', // *_AM/*_PM からの旧形式互換の派生値
  ]);
  const mergeRecordFields = (a, b) => {
    if (!a) return b; if (!b) return a;
    const at = Number(a._savedAt) || 0, bt = Number(b._savedAt) || 0;
    const aNewer = at >= bt;
    // ★ フィールド単位の更新時刻。 「実際に触った項目」だけ時刻が付く(空にした=意図的削除も含む)。
    //   触っていない空欄は時刻が付かないので、下の「非空優先」保護に委ねる(古い端末の空欄で入力を消さない)。
    const _aFts = (a._fieldTs && typeof a._fieldTs === 'object') ? a._fieldTs : {};
    const _bFts = (b._fieldTs && typeof b._fieldTs === 'object') ? b._fieldTs : {};
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach(k => {
      if (k === '_savedAt' || k === '_fieldTs') return;
      const av = a[k], bv = b[k];
      // ★ スカラー項目で _fieldTs があれば「新しい方」を採用(意図的に空にした削除も反映)。 バイタルもこれで削除可能。
      //   オブジェクト値(exercises 等)は下のキー単位マージに任せる(_fieldTs 短絡しない)。
      //   ★ 例外(FIELDTS_EXCLUDE): 画面側が「ユーザー編集ではない正規化/派生」で空文字を書く項目は、
      //     _fieldTs で「新しい空欄=削除」と誤判定すると別端末の入力を消してしまう → 常に下の非空優先に委ねる。
      //     ・nextDateOverride/nextTimeOverride: 空欄=未設定(自動計算に任せる)
      //     ・actualTime: 空欄=施設の既定提供時間を使う(入力UIは無く、保存時に必ず空で再構築される)
      //     ・temp/bpUpSt/... (サフィックス無し): *_AM/*_PM からの旧形式互換の派生値(独立した削除意図を持たない)
      //     ※ *_AM/*_PM のバイタルは対象外にしない = 意図的な削除は従来どおり反映される。
      if (!FIELDTS_EXCLUDE.has(k)
          && !(av && typeof av === 'object') && !(bv && typeof bv === 'object')) {
        const _aft = Number(_aFts[k]) || 0, _bft = Number(_bFts[k]) || 0;
        if (_aft || _bft) {
          // ★ バイタル(体温/血圧/脈 の *_AM/*_PM)の空↔非空は特別扱い。
          //   ・空側が「厳密に新しい _fieldTs」を持つ＝入力済みの値を"はっきり消した"(明示クリア) → クリアを反映。
          //   ・空側に時刻が無い/古い＝"最初から空欄""正規化の空""うっかり保存" → 非空を絶対に守る(事故的な全消し防止)。
          //   ※ 空欄への _fieldTs は 0c02dee 以降「値→空の明示クリア」のときだけ付く(未入力→空では付かない)ため、
          //     この2条件で「意図的な削除」と「事故的な空」を安全に切り分けられる。
          const _isVitalK = /^(temp|bpUpSt|bpDnSt|bpUpEn|bpDnEn|plSt|plEn)(_|$)/.test(k);
          if (_isVitalK) {
            const _ae = _isEmptyVal(av), _be = _isEmptyVal(bv);
            if (_ae !== _be) {
              const _emptyFt = _ae ? _aft : _bft;   // 空側の _fieldTs
              const _fullFt  = _ae ? _bft : _aft;   // 非空側の _fieldTs
              if (_emptyFt > _fullFt) { out[k] = _ae ? av : bv; return; } // 明示クリアが新しい → クリアを反映
              out[k] = _ae ? bv : av; return;                            // それ以外 → 非空を守る
            }
          }
          out[k] = (_aft >= _bft) ? av : bv; return;
        }
      }
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
        // ★ バイタル(体温/血圧/脈)は「空欄で消えない=非空を無条件優先」。
        //   記録を保存すると未入力の欄にも新しい _savedAt が付くため、他端末で入力したバイタルを
        //   『未入力の空欄=削除』と誤判定して消してしまう事故(終了血圧が全端末で空になる等)を防ぐ。
        //   特記/気分理由 等は従来どおり「新しい方が明示的に空にした=削除」を反映する。
        const _isVital = /^(temp|bpUpSt|bpDnSt|bpUpEn|bpDnEn|plSt|plEn)(_|$)/.test(k);
        if (!_isVital) {
          const newerIsEmpty = aNewer ? aEmpty : bEmpty;
          const newerStrict = aNewer ? (at > bt) : (bt > at);
          if (newerIsEmpty && newerStrict) { out[k] = aNewer ? av : bv; return; } // 明示的削除を反映
        }
        out[k] = aEmpty ? bv : av; // 非空を維持(バイタルは常に)
        return;
      }
      out[k] = aNewer ? av : bv; // 両方非空の競合 → 新しい方
    });
    out._savedAt = Math.max(at, bt);
    // _fieldTs は両者の項目別 max を保持
    { const mf = {}; new Set([...Object.keys(_aFts), ...Object.keys(_bFts)]).forEach(k => { const t = Math.max(Number(_aFts[k]) || 0, Number(_bFts[k]) || 0); if (t) mf[k] = t; }); if (Object.keys(mf).length) out._fieldTs = mf; }
    // ★ プレーンのバイタル(temp/bpUpSt/…)は *_AM/*_PM からの派生値(旧形式互換)。 これを独立にマージすると
    //   上の「バイタルは非空優先」により、一度入った値が空にしても永久に消えない。 その結果
    //   「提供記録入力は空欄なのに連絡帳/月間表には古い値が出続ける」ことになる。
    //   AM/PM を持つ記録では、マージ後に必ず AM/PM から射影し直して整合させる(空なら空にする)。
    const _PLAIN_VITALS = ['temp','bpUpSt','bpDnSt','plSt','bpUpEn','bpDnEn','plEn'];
    const _nonEmpty = (v) => v != null && String(v) !== '';
    if (_PLAIN_VITALS.some(f => (`${f}_AM` in out) || (`${f}_PM` in out))) {
      _PLAIN_VITALS.forEach(f => {
        const am = out[`${f}_AM`], pm = out[`${f}_PM`];
        if (am === undefined && pm === undefined) return; // AM/PM が無い項目は旧データなので触らない
        out[f] = _nonEmpty(am) ? am : (_nonEmpty(pm) ? pm : '');
      });
    }
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
  const FAMILY_CONTACT_FIELDS = new Set(['familyName','familyLastName','familyFirstName','familyKana','familyKanaLast','familyKanaFirst','familyRelation','familyPhone','familyPhoneMobile','familyEmail']);
  // ★ 利用者の「フィールド単位で時刻(_fieldTs)保護」する項目。 利用者を1項目編集して _savedAt 全体が
  //   更新されても、これらの項目は触っていなければ古い端末の保存で巻き戻らない(基本利用日/送迎/緊急連絡先)。
  const PATIENT_FIELDLEVEL = new Set(['scheduleAmPm','pickupType','pickupTimes','massageNeed','onyokuDenryo','plannedExercises','careLevel','careLevelFrom','careLevelTo','costBurden','costBurdenFrom','costBurdenTo','insuranceNo', ...FAMILY_CONTACT_FIELDS]);
  // ★ 削除済み書類の墓石を両端末ぶん合算する。 _delDocs = { "<書類id>": 削除時刻(ms) }
  //   和集合(union)マージは「追加を失わない」代わりに削除を必ず復活させるため、墓石で除外する。
  const _mergeDocTombs = (...srcs) => {
    const t = {};
    srcs.forEach(s => { if (s && typeof s === 'object') Object.keys(s).forEach(id => { const v = Number(s[id]) || 0; if (v >= (t[id] || 0)) t[id] = v; }); });
    return t;
  };
  const mergePatientBackfill = (lpArg, cpArg) => {
    // 墓石はローカル/クラウド双方の和集合。 どちらかで削除された書類は復活させない。
    const _tomb = _mergeDocTombs(cpArg && cpArg._delDocs, lpArg && lpArg._delDocs);
    const _isDead = (id) => id != null && !!_tomb[String(id)];
    if (!cpArg) return lpArg; if (!lpArg) return cpArg;
    // ★ 新しい方(_savedAt)を基準(lp)にし、古い方(cp)で空欄のみ補完する。
    //   これが無いと、古いスナップショットの端末が保存した際に、新しい端末で編集した
    //   「サービス提供内容」等が古い値へ巻き戻ってしまう。 _savedAt が無い旧データは
    //   従来どおりローカル(編集端末)基準 (後方互換)。
    const _lT = Number(lpArg._savedAt) || 0, _cT = Number(cpArg._savedAt) || 0;
    const lp = (_cT > _lT) ? cpArg : lpArg;   // 新しい方
    const cp = (_cT > _lT) ? lpArg : cpArg;   // 古い方(補完元)
    // ★ フィールド単位時刻(生ローカル/雲の _fieldTs を使う。 _savedAt の入れ替えとは独立)
    const _lFts = (lpArg._fieldTs && typeof lpArg._fieldTs === 'object') ? lpArg._fieldTs : {};
    const _cFts = (cpArg._fieldTs && typeof cpArg._fieldTs === 'object') ? cpArg._fieldTs : {};
    const out = { ...lp };
    out._savedAt = Math.max(_lT, _cT);
    // _fieldTs は両者の max を保持
    { const mf = {}; new Set([...Object.keys(_lFts), ...Object.keys(_cFts)]).forEach(k => { const t = Math.max(Number(_lFts[k]) || 0, Number(_cFts[k]) || 0); if (t) mf[k] = t; }); if (Object.keys(mf).length) out._fieldTs = mf; }
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
      if (k === '_savedAt' || k === '_fieldTs') return;
      // 状態は上で時刻優先で確定済みなら、下の汎用処理はスキップ
      if (_statusTimed && (k === 'status' || k === 'pauseHistory' || k === 'statusUpdatedAt')) return;
      // ★ フィールド単位保護対象 かつ どちらかに _fieldTs があれば、その項目だけ新しい方を採用(生ローカル/雲を参照)。
      //   これで「別項目を編集した古い端末」が基本利用日/送迎/緊急連絡先を巻き戻さない。 時刻が無い項目は従来処理へ。
      if (PATIENT_FIELDLEVEL.has(k)) {
        const _lft = Number(_lFts[k]) || 0, _cft = Number(_cFts[k]) || 0;
        if (_lft || _cft) { out[k] = (_lft >= _cft) ? lpArg[k] : cpArg[k]; return; }
      }
      const lv = lp[k], cv = cp[k];
      // ★ 書類(介護保険証/負担割合証)と更新ログ: 両端末の追加を失わないよう id 単位で和集合マージ。
      //   docUpdates は既読フラグ(readOffice/readCm)を両者で OR (どちらかが既読なら既読)。
      if (k === 'docInsurance' || k === 'docBurden' || k === 'docUpdates') {
        const la = Array.isArray(lv) ? lv : [], ca = Array.isArray(cv) ? cv : [];
        if (!la.length && !ca.length) return;
        const byId = new Map();
        // ★ 墓石にある id は復活させない (削除がクラウド側の残存で戻る不具合の恒久対策)
        ca.forEach(d => { if (d && d.id != null && !_isDead(d.id)) byId.set(String(d.id), d); });
        la.forEach(d => {
          if (!d || d.id == null || _isDead(d.id)) return;
          const key = String(d.id), prev = byId.get(key);
          if (prev && k === 'docUpdates') byId.set(key, { ...prev, ...d, readOffice: !!(prev.readOffice || d.readOffice), readCm: !!(prev.readCm || d.readCm) });
          else byId.set(key, d);
        });
        out[k] = [...byId.values()];
        return;
      }
      // ★ 介護度/負担割合の変更履歴は「追加のみ」の記録。 両端末の追記を失わないよう和集合(JSON重複排除)で残す。
      if (k === 'careLevelHistory' || k === 'costBurdenHistory') {
        const la = Array.isArray(lv) ? lv : [], ca = Array.isArray(cv) ? cv : [];
        if (!la.length && !ca.length) return;
        const seen = new Set(); const merged = [];
        [...ca, ...la].forEach(h => { let key; try { key = JSON.stringify(h); } catch { key = String(h); } if (!seen.has(key)) { seen.add(key); merged.push(h); } });
        out[k] = merged; return;
      }
      // ★ scheduleAmPm(基本利用日)は「無し」も意図的な設定値。 index 単位の空欄補完をすると、
      //   ある曜日を「無し」にしても クラウドの旧値(AM/PM)で復活してしまう。 最後の編集(ローカル)を優先する。
      if (k === 'scheduleAmPm') { out[k] = (lv !== undefined) ? lv : cv; return; }
      // ★ 緊急連絡先(代表家族)の各項目は「空欄=意図的な削除」。 空欄補完でクラウドの旧値から復活すると、
      //   削除しても数秒後に戻る不具合になる。 新しい方(_savedAt優先の lp)の値を採用し、空欄なら空欄のままにする。
      if (FAMILY_CONTACT_FIELDS.has(k)) { out[k] = (lv !== undefined) ? lv : cv; return; }
      const lObj = lv && typeof lv === 'object' && !Array.isArray(lv);
      const cObj = cv && typeof cv === 'object' && !Array.isArray(cv);
      // プレーンオブジェクト(plannedExercises 等): キー単位で「ローカル空欄のみクラウドで補完」
      if (lObj || cObj) {
        const lo = lObj ? lv : {}, co = cObj ? cv : {};
        const mo = { ...lo };
        Object.keys(co).forEach(kk => { if (_isEmptyVal(mo[kk]) && !_isEmptyVal(co[kk])) mo[kk] = co[kk]; });
        // ★ personalFile(介護保険証/負担割合証のメタ・フェイスシート・担当者会議 等)はサブキー単位で
        //   _fieldTs['pf:'+kk] の新しい方を採用する。 これで別項目を触った古い端末が、他店の保険証/フェイスシート
        //   更新を「新しい利用者スナップショット」の名目で巻き戻す不具合を防ぐ。 assessment は下の和集合に委ねる。
        if (k === 'personalFile') {
          const _lpf = (lpArg.personalFile && typeof lpArg.personalFile === 'object') ? lpArg.personalFile : {};
          const _cpf = (cpArg.personalFile && typeof cpArg.personalFile === 'object') ? cpArg.personalFile : {};
          new Set([...Object.keys(_lpf), ...Object.keys(_cpf)]).forEach(kk => {
            if (kk === 'assessment') return;
            const lft = Number(_lFts['pf:' + kk]) || 0, cft = Number(_cFts['pf:' + kk]) || 0;
            if (lft || cft) mo[kk] = (lft >= cft) ? _lpf[kk] : _cpf[kk];
          });
        }
        // ★ personalFile.assessment: 事業所/ケアマネ双方の編集を保持
        //   text は updatedAt が新しい方、files は id 単位で和集合。
        if (k === 'personalFile' && (lo.assessment || co.assessment)) {
          const la = lo.assessment || {}, ca = co.assessment || {};
          const byId = new Map();
          // ★ 墓石にある添付は復活させない
          (ca.files || []).forEach(d => { if (d && d.id != null && !_isDead(d.id)) byId.set(String(d.id), d); });
          (la.files || []).forEach(d => { if (d && d.id != null && !_isDead(d.id)) byId.set(String(d.id), d); });
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
    // ★ 墓石は必ず和集合で残す。 片方の端末が古い墓石を落とすと、その id がまた復活してしまうため。
    if (Object.keys(_tomb).length) out._delDocs = _tomb;
    return out;
  };
  try {
    // ★ 楽観ロック(CAS)経由: 「最新取得 → マージ → version一致でDB原子的更新」。 競合(返り行0)は自動で再取得・再マージ・再試行。
    //   読めない(通信/RLSエラー)は supabaseCasUpdate 内で throw → 下の catch で保存中止(既存データを守る)。
    // ★ 通常保存は端末が増えるほど競合しやすい(自動保存1.2秒＋4秒ポーリング)。 既定5回だと
    //   混み合った時に「上限到達=保存失敗」になりやすいので、この経路だけ再試行を厚くする。
    const _casRes = await supabaseCasUpdate(storeId, (cloud) => {
    // クラウドが空(=新規店舗) ならそのまま(初回作成)
    if (!cloud || Object.keys(cloud).length === 0) {
      return sanitizeForSync(localData);
    }
    // 記録系の配列は id 単位でマージ (どちらの端末の記録も残す)。
    // ※ patients/systemSettings は _savedAt が無く、 record 保存時に誤って古い内容で
    //   上書きする恐れがあるためマージ対象に含めない (= 従来どおり編集端末の値を採用)。
    const ARRAY_KEYS = ['ticketRecords','dailyLogs','monitoringRecords','fitnessRecords','initialReports','familyAnnouncements','familyPersonalAnnouncements','familyPhotos','kinouKeikakuRecords','seikatsuKinouRecords','kyomiKanshinRecords','tsushoKeikakuRecords','scheduleEvents','faxHistory','auditLog'];
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
      // ★ 操作ログ方式へ移行済みのデータは、巨大JSON側では一切書き換えない(スナップショットとして凍結)。
      //   ここで書き換えると、操作ログと巨大JSONが同じデータを奪い合い、以前と同じ消失事故になる。
      //   実効状態 = このスナップショット + __snapRevision より新しい操作ログ。
      if (isOplogFrozen(k)) { merged[k] = Array.isArray(cloud[k]) ? cloud[k] : (Array.isArray(localData[k]) ? localData[k] : []); return; }
      const tomb = mergedTomb[k] || {};
      const arr = FIELD_MERGE_KEYS.has(k) ? mergeByIdFieldLevel(localData[k], cloud[k]) : mergeById(localData[k], cloud[k]);
      let _m = arr.filter(r => !(r && r.id != null && tomb[String(r.id)]));
      // ★ 変更ログは端末間でunion併合されるので肥大しないよう時刻降順で最新300件に制限
      if (k === 'auditLog') _m = _m.slice().sort((a,b)=>(Number(b&&b.at)||0)-(Number(a&&a.at)||0)).slice(0, 300);
      merged[k] = _m;
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
    // ★ オブジェクトをフィールド単位でマージ。 各フィールドは _fieldTs[field] の新しい方を採用。
    //   _fieldTs が両者に無いフィールドは、全体 _updatedAt の新しい方(base)を採用(後方互換)。
    //   → 古い端末が別フィールドを1つ編集して _updatedAt を更新しても、触っていないフィールドは巻き戻らない。
    //   (これが「1項目直すと他が復活する / 数時間〜数日で戻る」不具合の恒久対策)。
    const mergeObjFieldLevel = (lo, co) => {
      if (!lo) return co; if (!co) return lo;
      const lT = Number(lo._updatedAt) || 0, cT = Number(co._updatedAt) || 0;
      const lFts = (lo._fieldTs && typeof lo._fieldTs === 'object') ? lo._fieldTs : {};
      const cFts = (co._fieldTs && typeof co._fieldTs === 'object') ? co._fieldTs : {};
      const base = (lT >= cT) ? lo : co;
      const out = { ...base };
      const keys = new Set([...Object.keys(lo), ...Object.keys(co)]);
      keys.forEach(k => {
        if (k === '_updatedAt' || k === '_fieldTs') return;
        const lft = Number(lFts[k]) || 0, cft = Number(cFts[k]) || 0;
        if (lft || cft) { out[k] = (lft >= cft) ? lo[k] : co[k]; }
        else if (!(k in base)) { out[k] = (k in lo) ? lo[k] : co[k]; }
      });
      const mFts = {};
      new Set([...Object.keys(lFts), ...Object.keys(cFts)]).forEach(k => { const t = Math.max(Number(lFts[k]) || 0, Number(cFts[k]) || 0); if (t) mFts[k] = t; });
      out._fieldTs = mFts; out._updatedAt = Math.max(lT, cT);
      return out;
    };
    // ★ systemSettings: フィールド単位マージ。 ケアマネ事業所/担当者は union で両端末の追加を保持。
    {
      const ls = localData.systemSettings, cs = cloud.systemSettings;
      if (ls || cs) {
        if (!ls || !cs) { merged.systemSettings = ls || cs; }
        else {
          const out = mergeObjFieldLevel(ls, cs);
          // ★ 追加を失わない配列は union(両端末の追加を保持。 同一キーはローカル優先)。
          const unionBy = (k, keyFn) => {
            const a = Array.isArray(ls[k]) ? ls[k] : [], b = Array.isArray(cs[k]) ? cs[k] : [];
            if (!a.length && !b.length) return;
            const m = new Map();
            b.forEach(x => { const kk = keyFn(x); if (kk != null) m.set(kk, x); });
            a.forEach(x => { const kk = keyFn(x); if (kk != null) m.set(kk, x); });
            out[k] = [...m.values()];
          };
          unionBy('cmOffices', o => (o && o.name != null) ? `off|${String(o.name).trim()}` : null);
          unionBy('careManagers', o => (o && (o.office != null || o.name != null)) ? `cm|${String(o.office||'').trim()}|${String(o.name||'').trim()}` : null);
          merged.systemSettings = out;
        }
      }
    }
    // ★ 連絡帳設定(contactBookConfig=連絡事項/掲載期間/定型文)もフィールド単位マージ。
    //   丸ごと採用だと、古い端末が別項目を1つ触っただけで 連絡事項・掲載期間(〜8/31等)が
    //   その端末の古い内容で上書きされ、毎回巻き戻っていた。
    {
      const lc = localData.contactBookConfig, cc = cloud.contactBookConfig;
      if (lc || cc) {
        if (!lc || !cc) merged.contactBookConfig = lc || cc;
        else merged.contactBookConfig = mergeObjFieldLevel(lc, cc);
      }
    }
    // ★ 日誌設定(diarySettings=担当職員/送迎車/タイムスケジュール/送迎自動コピー)もフィールド単位マージ。
    //   古い端末が職員を1人足しただけで送迎自動コピー等が巻き戻るのを防ぐ。
    {
      const lc = localData.diarySettings, cc = cloud.diarySettings;
      if (lc || cc) {
        if (!lc || !cc) merged.diarySettings = lc || cc;
        else merged.diarySettings = mergeObjFieldLevel(lc, cc);
      }
    }
    // ★ 休み連絡(faxDataStore=日付×利用者の連絡状態)は「日付|利用者」キー単位でマージし、同キーは新しい方(_updatedAt)。
    //   端末間で別々の人を編集しても消えないように。
    {
      const ls = (localData.faxDataStore && typeof localData.faxDataStore === 'object') ? localData.faxDataStore : null;
      const cs = (cloud.faxDataStore && typeof cloud.faxDataStore === 'object') ? cloud.faxDataStore : null;
      if (ls || cs) {
        const out = { ...(cs || {}) };
        Object.keys(ls || {}).forEach(k => {
          const lv = ls[k], cv = (cs || {})[k];
          if (!cv) { out[k] = lv; return; }
          const lt = Number(lv && lv._updatedAt) || 0, ct = Number(cv && cv._updatedAt) || 0;
          out[k] = (lt >= ct) ? lv : cv;
        });
        merged.faxDataStore = out;
      }
    }
    // ★ 各種連絡の下書き(generalFaxDraft)も「新しい方(_updatedAt)」を採用。
    {
      const lc = localData.generalFaxDraft, cc = cloud.generalFaxDraft;
      if (lc || cc) {
        const lt = Number(lc && lc._updatedAt) || 0, ct = Number(cc && cc._updatedAt) || 0;
        if (lt || ct) merged.generalFaxDraft = (lt >= ct) ? lc : cc;
        else merged.generalFaxDraft = lc || cc;
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
          if (lt || ct) {
            // ★ フィールド単位: _fieldTs のある項目はその項目だけ新しい方を採用する。
            //   (古い端末の「1週間前の送迎の自動コピー」等が、他端末で入力済みの本物の送迎を潰さない)
            //   _fieldTs が無い項目は、従来どおりログ全体の _savedAt が新しい方(base)を採用。
            const lFts = (lv && lv._fieldTs && typeof lv._fieldTs === 'object') ? lv._fieldTs : {};
            const cFts = (cv && cv._fieldTs && typeof cv._fieldTs === 'object') ? cv._fieldTs : {};
            const base = (lt >= ct) ? lv : cv;
            const o = { ...base };
            new Set([...Object.keys(lv || {}), ...Object.keys(cv || {})]).forEach(kk => {
              if (kk === '_savedAt' || kk === '_fieldTs') return;
              const lft = Number(lFts[kk]) || 0, cft = Number(cFts[kk]) || 0;
              if (lft || cft) o[kk] = (lft >= cft) ? lv[kk] : cv[kk];
              else if (!(kk in base)) o[kk] = (kk in (lv || {})) ? lv[kk] : cv[kk];
            });
            const mf = {};
            new Set([...Object.keys(lFts), ...Object.keys(cFts)]).forEach(kk => { const t = Math.max(Number(lFts[kk]) || 0, Number(cFts[kk]) || 0); if (t) mf[kk] = t; });
            if (Object.keys(mf).length) o._fieldTs = mf;
            o._savedAt = Math.max(lt, ct);
            outLogs[k] = o;
          }
          else outLogs[k] = (JSON.stringify(lv).length >= JSON.stringify(cv).length) ? lv : cv; // 旧データ(時刻なし)のみ従来判定
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
        // ★ 月間シフトは「利用者×月ごとの時刻(_msTs)」で新しい方を採用する。
        //   全体で1つの時刻(_msSavedAt)だと、別の利用者/月を1つ触っただけの古い端末が、
        //   他端末の振替まで「新しい」と誤判定して古い内容で上書きし戻してしまうため。
        //   時刻が無い(旧データ)ときのみ、全体の _msSavedAt で従来判定にフォールバック。
        const lTs = (localData._msTs && typeof localData._msTs === 'object') ? localData._msTs : {};
        const cTs = (cloud._msTs && typeof cloud._msTs === 'object') ? cloud._msTs : {};
        const lMsT = Number(localData._msSavedAt) || 0, cMsT = Number(cloud._msSavedAt) || 0;
        const localNewerGlobal = lMsT >= cMsT;
        const outMs = {}; const outTs = {};
        const monthKeys = new Set([...Object.keys(lMs || {}), ...Object.keys(cMs || {})]);
        monthKeys.forEach(mk => {
          const lm = (lMs && lMs[mk] && typeof lMs[mk] === 'object') ? lMs[mk] : {};
          const cm = (cMs && cMs[mk] && typeof cMs[mk] === 'object') ? cMs[mk] : {};
          const lmTs = (lTs[mk] && typeof lTs[mk] === 'object') ? lTs[mk] : {};
          const cmTs = (cTs[mk] && typeof cTs[mk] === 'object') ? cTs[mk] : {};
          const om = {}; const omTs = {};
          const pids = new Set([...Object.keys(lm), ...Object.keys(cm)]);
          pids.forEach(pid => {
            const hasL = Object.prototype.hasOwnProperty.call(lm, pid);
            const hasC = Object.prototype.hasOwnProperty.call(cm, pid);
            if (hasL && hasC) {
              const lt = Number(lmTs[pid]) || 0, ct = Number(cmTs[pid]) || 0;
              // 患者×月の時刻があればそれで判定。 無ければ全体時刻でフォールバック。
              const useLocal = (lt || ct) ? (lt >= ct) : localNewerGlobal;
              om[pid] = useLocal ? lm[pid] : cm[pid];
            } else if (hasL) { om[pid] = lm[pid]; }
            else { om[pid] = cm[pid]; }
            // 時刻は「新しい方」を保持(両端末で存在すれば max)
            const _t = Math.max(Number(lmTs[pid]) || 0, Number(cmTs[pid]) || 0);
            if (_t) omTs[pid] = _t;
          });
          outMs[mk] = om;
          if (Object.keys(omTs).length) outTs[mk] = omTs;
        });
        merged.monthlyShifts = outMs;
        merged._msTs = outTs;
        merged._msSavedAt = Math.max(lMsT, cMsT);
      }
    }
    // ★ 勤務表(workSchedule): monthlyShifts と同方式で「スタッフ×月ごとの時刻(_wsTs)」で新しい方を採用。
    {
      const lWs = (localData.workSchedule && typeof localData.workSchedule === 'object') ? localData.workSchedule : null;
      const cWs = (cloud.workSchedule && typeof cloud.workSchedule === 'object') ? cloud.workSchedule : null;
      if (lWs || cWs) {
        const lTs = (localData._wsTs && typeof localData._wsTs === 'object') ? localData._wsTs : {};
        const cTs = (cloud._wsTs && typeof cloud._wsTs === 'object') ? cloud._wsTs : {};
        const lWsT = Number(localData._wsSavedAt) || 0, cWsT = Number(cloud._wsSavedAt) || 0;
        const localNewerGlobal = lWsT >= cWsT;
        const outWs = {}; const outTs = {};
        const monthKeys = new Set([...Object.keys(lWs || {}), ...Object.keys(cWs || {})]);
        monthKeys.forEach(mk => {
          const lm = (lWs && lWs[mk] && typeof lWs[mk] === 'object') ? lWs[mk] : {};
          const cm = (cWs && cWs[mk] && typeof cWs[mk] === 'object') ? cWs[mk] : {};
          const lmTs = (lTs[mk] && typeof lTs[mk] === 'object') ? lTs[mk] : {};
          const cmTs = (cTs[mk] && typeof cTs[mk] === 'object') ? cTs[mk] : {};
          const om = {}; const omTs = {};
          const sids = new Set([...Object.keys(lm), ...Object.keys(cm)]);
          sids.forEach(sid => {
            const hasL = Object.prototype.hasOwnProperty.call(lm, sid);
            const hasC = Object.prototype.hasOwnProperty.call(cm, sid);
            if (hasL && hasC) {
              const lt = Number(lmTs[sid]) || 0, ct = Number(cmTs[sid]) || 0;
              const useLocal = (lt || ct) ? (lt >= ct) : localNewerGlobal;
              om[sid] = useLocal ? lm[sid] : cm[sid];
            } else if (hasL) { om[sid] = lm[sid]; }
            else { om[sid] = cm[sid]; }
            const _t = Math.max(Number(lmTs[sid]) || 0, Number(cmTs[sid]) || 0);
            if (_t) omTs[sid] = _t;
          });
          outWs[mk] = om;
          if (Object.keys(omTs).length) outTs[mk] = omTs;
        });
        merged.workSchedule = outWs;
        merged._wsTs = outTs;
        merged._wsSavedAt = Math.max(lWsT, cWsT);
      }
    }
    // ★ ticketRecords は「患者+日付」で必ず1件に正規化。 旧ランダムid×新決定idの重複や、
    //   空欄の記録が入力済みの記録を上書きするのを防ぐ。 データが多い方(同点なら新しい方)を残す。
    // ★ 操作ログ方式に移行済みの場合、この正規化はスナップショットを書き換えてしまうので行わない。
    if (!isOplogFrozen('ticketRecords') && Array.isArray(merged.ticketRecords)) {
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
    // ★ お知らせの既読(スタッフ単位)は「和集合」で統合する。 どちらの端末で既読にしても
    //   既読のまま残り、片方の端末の古い状態で未読に戻らないようにする。
    {
      const lo = localData.noticeReads, co = cloud.noticeReads;
      if (lo || co) {
        const out = {};
        new Set([...Object.keys(lo || {}), ...Object.keys(co || {})]).forEach(k => {
          const a = Array.isArray(lo && lo[k]) ? lo[k] : [];
          const b = Array.isArray(co && co[k]) ? co[k] : [];
          out[k] = [...new Set([...b.map(String), ...a.map(String)])].slice(-1000);
        });
        merged.noticeReads = out;
      }
    }
    return sanitizeForSync(merged);
    }, { maxRetries: 12 }); // supabaseCasUpdate の mutate 終わり (2台同時編集の競合に耐えるため厚め)
    const _ok = !!(_casRes && _casRes.ok);
    if (_ok) { syncHealth.lastOkAt = Date.now(); syncLog('push-ok', { v: _casRes.version }); }
    else { syncHealth.lastFailAt = Date.now(); syncHealth.lastError = (_casRes && _casRes.reason) || 'unknown'; syncLog('push-fail', { reason: syncHealth.lastError }); }
    return _ok;
  } catch (e) {
    console.warn('[supabase] mergeAndSync exception', e);
    syncHealth.lastFailAt = Date.now();
    syncHealth.lastError = String((e && e.message) || e);
    syncLog('push-error', { err: syncHealth.lastError });
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
  // ★ pull でもクラウドの最大同期時刻を取り込む (編集を始める前に自分の時計を追いつかせる)
  try { const d = data && data.data; observeRemoteClock(d && d.__clock ? d.__clock : maxRecordClock(d)); } catch {}
  return data; // 行が無ければ null (= 真の新規店舗)。 それ以外は { data, updated_at }
}

// =========================================================
// 全店共通ポリシー (つむぎ管理局が編集 → 予約キー __tsumugi_global__ の app_state に保存し、各店が読む)
//   ※ stores テーブルとは別なので「偽店舗」は一覧に出ない。
// =========================================================
export const GLOBAL_STATE_KEY = '__tsumugi_global__';
export async function supabaseLoadGlobalPolicies() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('data')
      .eq('key', GLOBAL_STATE_KEY)
      .maybeSingle();
    if (error) { console.warn('[supabase] loadGlobalPolicies error', error); return null; }
    return (data && data.data && data.data.policies) ? data.data.policies : null;
  } catch (e) { console.warn('[supabase] loadGlobalPolicies exception', e); return null; }
}
export async function supabaseSaveGlobalPolicies(policies) {
  if (!supabase) return false;
  try {
    // ★ CAS経由: 既存の共通レコードに policies だけ差し替え(将来の共通データがあれば保持)。 競合時は再取得して再適用。
    const _now = Date.now();
    const res = await supabaseCasUpdate(GLOBAL_STATE_KEY, (cur) => {
      const base = (cur && typeof cur === 'object') ? cur : {};
      return { ...base, policies, _updatedAt: _now };
    });
    return !!(res && res.ok);
  } catch (e) { console.warn('[supabase] saveGlobalPolicies exception', e); return false; }
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
    // ★ CAS: 連絡先/relatedParties/docUpdates の統合は dedup・id和集合で「冪等」。 patientPatch/extra は
    //   呼び出し側で固定生成済み(再試行しても不変)なので、応答ロス→再試行で二重追加は起きない。
    const res = await supabaseCasUpdate(storeId, (cloud) => {
    const currentData = cloud;
    if (!currentData) return null; // 店舗行が無い → 何もしない
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
    return updatedData;
    }); // supabaseCasUpdate mutate 終わり
    return !!(res && res.ok);
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
    // ★ ID冪等: 追加要素の id/at は CAS を呼ぶ前に1回だけ固定生成(mutate内で毎回生成しない)。
    //   応答ロス→再試行で最新cloudに同idが既存なら追加しない(重複防止)。
    const _now = new Date().toISOString();
    const e = {
      id: entry.id || `du_${_now}_${Math.round(Math.random() * 1e6)}`,
      at: entry.at || _now,
      by: entry.by || 'family',
      byName: entry.byName || '',
      items: [...new Set(entry.items || [])],
      readOffice: false,
      readCm: true,
    };
    const res = await supabaseCasUpdate(storeId, (cloud) => {
      const currentData = cloud;
      if (!currentData) return null;
      let matched = false, already = false;
      const patients = (currentData.patients || []).map(p => {
        if (String(p.id) !== String(patientId)) return p;
        matched = true;
        const log = Array.isArray(p.docUpdates) ? p.docUpdates : [];
        if (log.some(u => u && u.id === e.id)) { already = true; return p; } // 同id既存=冪等スキップ
        return { ...p, docUpdates: [...log, e].slice(-50) };
      });
      if (!matched || already) return null; // 対象なし or 既反映 → 書き込まない(noop)
      return { ...currentData, patients };
    });
    return !!(res && res.ok);
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
    // ★ ID冪等: now と docUpdate id(_duId) を CAS前に1回固定。 応答ロス→再試行で同idが既存なら、
    //   フェイスシート版(hist)も docUpdate も二重追加しない(version の二重加算も防止)。
    const _now = new Date().toISOString();
    const _duId = `du_${_now}_${Math.round(Math.random() * 1e6)}`;
    const res = await supabaseCasUpdate(storeId, (cloud) => {
      const currentData = cloud;
      if (!currentData) return null;
      let matched = false, already = false;
      const patients = (currentData.patients || []).map(p => {
        if (String(p.id) !== String(patientId)) return p;
        matched = true;
        const log = Array.isArray(p.docUpdates) ? p.docUpdates : [];
        if (log.some(u => u && u.id === _duId)) { already = true; return p; } // 同id既存=冪等スキップ
        const pf = p.personalFile || {};
        const newFs = { ...(pf.faceSheet || {}), ...(faceSheet || {}), updatedAt: _now, updatedBy: meta.updatedBy || 'ケアマネ' };
        const prevHist = Array.isArray(pf.faceSheetHistory) ? pf.faceSheetHistory : [];
        const version = ((prevHist[prevHist.length - 1] || {}).version || 0) + 1;
        const { genogramFiles, floorPlanFiles, pickupRouteFiles, ...textOnly } = newFs;
        const snapshot = { ...textOnly, _attachCounts: { genogram: (genogramFiles || []).length, floorPlan: (floorPlanFiles || []).length, pickupRoute: (pickupRouteFiles || []).length } };
        const hist = [...prevHist, { version, updatedAt: _now, updatedBy: newFs.updatedBy, source: meta.source || 'caremanager', snapshot }].slice(-20);
        const docUpdates = [...log, { id: _duId, at: _now, by: 'caremanager', byName: newFs.updatedBy, items: ['フェイスシート'], readOffice: false, readCm: true }].slice(-50);
        // ★ F1: フェイスシートの既往歴(kiou)を患者トップにもミラー(計画書/CSV/帳票が参照する source of truth)
        return { ...p, kiou: (newFs.kiou ?? p.kiou ?? ''), docUpdates, personalFile: { ...pf, faceSheet: newFs, faceSheetHistory: hist } };
      });
      if (!matched || already) return null;
      return { ...currentData, patients };
    });
    return !!(res && res.ok);
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
    // ★ ID冪等: now と docUpdate id(_duId) を CAS前に1回固定。 応答ロス→再試行で同idが既存なら docUpdate を二重追加しない。
    const now = new Date().toISOString();
    const byName = meta.byName || 'ケアマネ';
    const _duId = `du_${now}_${Math.round(Math.random() * 1e6)}`;
    const res = await supabaseCasUpdate(storeId, (cloud) => {
    const currentData = cloud;
    if (!currentData) return null;
    let changed = [];
    const patients = (currentData.patients || []).map(p => {
      if (String(p.id) !== String(patientId)) return p;
      const np = { ...p };
      // ★ 事業所側で削除済み(墓石)の書類は、ケアマネ端末に残っていても再追加しない
      const _tomb = (p && p._delDocs && typeof p._delDocs === 'object') ? p._delDocs : {};
      const unionDocs = (key, incoming, label) => {
        if (!Array.isArray(incoming) || !incoming.length) return;
        const ex = Array.isArray(np[key]) ? np[key] : [];
        const ids = new Set(ex.map(d => String(d && d.id)));
        const add = incoming.filter(d => d && !ids.has(String(d.id)) && !_tomb[String(d.id)]);
        if (add.length) { np[key] = [...ex, ...add]; changed.push(label); }
      };
      unionDocs('docInsurance', patch.docInsurance, '介護保険証');
      unionDocs('docBurden', patch.docBurden, '負担割合証');
      // 保険証・負担割合証の内容(介護度/認定有効期間/負担割合)を利用者マスタへ反映。 値変更は変更履歴にも記録。
      const m = patch.master || {};
      const nowDay = now.split('T')[0];
      // ★ App.jsx の appendValueHistory と同じ規則: 値の変更に加え、値が同じでも認定有効期間の
      //   開始日が変わったら「認定更新」として1件残す(prevFrom を渡した時のみ判定)。
      const appendHist = (histKey, oldVal, newVal, from, to, prevFrom) => {
        const hist = Array.isArray(np[histKey]) ? [...np[histKey]] : [];
        const nv = newVal == null ? '' : String(newVal);
        if (!nv) return hist;
        const f = from || nowDay;
        const last = hist.length ? hist[hist.length - 1] : null;
        const valChanged = String(oldVal || '') !== nv;
        const periodChanged = prevFrom !== undefined && String(prevFrom || '') !== String(from || '');
        if (last && String(last.value || '') === nv && String(last.from || '') === String(f)) {
          if (to && String(last.to || '') !== String(to)) hist[hist.length - 1] = { ...last, to };
          return hist;
        }
        if (!valChanged && !periodChanged) return hist;
        if (oldVal) {
          if (last && !last.to) hist[hist.length - 1] = { ...last, to: f };
          else if (!hist.length) hist.push({ value: oldVal, from: prevFrom || null, to: f, note: '' });
        }
        hist.push({ value: nv, from: f, to: to || null, note: valChanged ? '' : '認定更新' });
        return hist;
      };
      // 介護度: 値が変わった時、または 値は同じでも認定開始日が変わった時に履歴を残す
      const _mCl = (m.careLevel != null && m.careLevel !== '') ? String(m.careLevel) : String(np.careLevel || '');
      const _mClFrom = (m.careLevelFrom != null && m.careLevelFrom !== '') ? String(m.careLevelFrom) : (np.careLevelFrom || '');
      if (_mCl && (_mCl !== String(np.careLevel || '') || _mClFrom !== String(np.careLevelFrom || ''))) {
        np.careLevelHistory = appendHist('careLevelHistory', np.careLevel, _mCl, _mClFrom, (m.careLevelTo || np.careLevelTo), np.careLevelFrom);
        if (_mCl !== String(np.careLevel || '')) { np.careLevel = _mCl; changed.push('介護度'); }
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
        // ★ 同 _duId が既存なら二重追加しない(応答ロス→再試行の冪等)
        np.docUpdates = log.some(u => u && u.id === _duId) ? log : [...log, { id: _duId, at: now, by: 'caremanager', byName, items, readOffice: false, readCm: true }].slice(-50);
      }
      return np;
    });
    if (!changed.length) return null; // 変更なし → 書き込まない(noop)
    return { ...currentData, patients };
    }); // supabaseCasUpdate mutate 終わり
    return !!(res && res.ok);
  } catch (e) { console.warn('[supabase] mergePatientDocsFromCM failed', e); return false; }
}

// ★ docUpdates の既読フラグだけを更新 (side='cm' → readCm:true / side='office' → readOffice:true)。
//   ケアマネ画面は全体stateをpushしないため、ここで対象店舗のデータを読み直して該当項目のみ更新。
export async function supabaseMarkDocUpdatesRead(storeId, patientId, side = 'cm') {
  if (!supabase || !storeId || !patientId) return false;
  try {
    // ★ 既読フラグを立てるだけ＝本質的に冪等(再試行で同じ結果)。 CAS化して古いデータで上書きしない。
    const flag = side === 'office' ? 'readOffice' : 'readCm';
    const res = await supabaseCasUpdate(storeId, (cloud) => {
      const currentData = cloud;
      if (!currentData) return null;
      let touched = false;
      const patients = (currentData.patients || []).map(p => {
        if (String(p.id) !== String(patientId)) return p;
        const log = Array.isArray(p.docUpdates) ? p.docUpdates : [];
        if (!log.some(u => !u[flag])) return p;
        touched = true;
        return { ...p, docUpdates: log.map(u => u[flag] ? u : { ...u, [flag]: true }) };
      });
      if (!touched) return null; // 既に全既読 → 書き込まない
      return { ...currentData, patients };
    });
    return !!(res && res.ok);
  } catch (e) { console.warn('[supabase] markDocUpdatesRead failed', e); return false; }
}

// ★ 店舗の管理者パスワード(adminAuth)だけを安全に更新する。
//   対象店舗のクラウドデータを読み直し、systemSettings.adminAuth のみ変更して書き戻す。
//   → 店舗切替直後などに「別店舗の appData 全体」を誤って書き込む(=店舗間データ混在)のを防ぐ。
// ★ 管理局から店舗のアドオンをON/OFFする。 CAS内で「読み→変更」を完結させ、_fieldTs.addons を必ず更新する。
//   これをしないと:
//   ①読み(supabaseLoadStateForStore)→書きの間に別の切替が入ると、後の書きが前の切替を消す
//     (アドオンを続けて複数ONにすると最後の1個しか残らない)
//   ②_fieldTs.addons が古いままなので、店舗側の端末が次に保存した時にフィールド単位マージで
//     「ローカル(古いaddons)が新しい」と判定され、管理局の変更が巻き戻る
export async function supabaseSetStoreAddon(storeId, key, value) {
  if (!supabase || !storeId || !key) return false;
  try {
    const res = await supabaseCasUpdate(storeId, (cloud) => {
      // ★ クラウドの時刻を取り込んだ後に刻む (CAS再試行のたびに最新化)
      const now = syncNow();
      const data = cloud || {};
      const ss = data.systemSettings || {};
      const nextAddons = { ...(ss.addons || {}), [key]: !!value };
      const nextFts = { ...(ss._fieldTs && typeof ss._fieldTs === 'object' ? ss._fieldTs : {}), addons: now };
      return { ...data, systemSettings: { ...ss, addons: nextAddons, _fieldTs: nextFts, _updatedAt: now } };
    });
    return !!(res && res.ok);
  } catch (e) { console.warn('[supabase] setStoreAddon failed', e); return false; }
}

export async function supabaseSetStoreAdminAuth(storeId, authPatch) {
  if (!supabase || !storeId) return false;
  try {
    const _setAt = Date.now();
    const res = await supabaseCasUpdate(storeId, (cloud) => {
      const data = cloud || {};
      const nextSettings = { ...(data.systemSettings || {}), adminAuth: { ...(data.systemSettings?.adminAuth || {}), ...(authPatch || {}), setAt: _setAt } };
      return { ...data, systemSettings: nextSettings };
    });
    return !!(res && res.ok);
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
