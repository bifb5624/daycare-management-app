// ★ つむぎ 純粋ロジック (副作用なし)。 ここに集約して自動テスト(logic.test.js)で守る。
//   App.jsx から import して使う(同じ実装を使うことで「テストが通る=本番も正しい」を担保)。

// 招待トークン: 任意オブジェクト ⇄ URLセーフ base64 (UTF-8対応)
export const encodeInviteToken = (obj) => {
  try {
    const json = JSON.stringify(obj);
    const utf8 = unescape(encodeURIComponent(json));
    return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch { return ''; }
};
export const decodeInviteToken = (token) => {
  try {
    if (!token) return null;
    let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const utf8 = atob(b64);
    return JSON.parse(decodeURIComponent(escape(utf8)));
  } catch { return null; }
};

// 入力コード正規化: 半角化・大文字化・ハイフン自動補完 (FAM-XXXX-XXXX)
export const normalizeInviteCode = (raw) => {
  const s = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length <= 3) return s;
  if (s.length <= 7) return `${s.slice(0, 3)}-${s.slice(3)}`;
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7, 11)}`;
};

// 個別運動スロット {itemId,value} の表示用解決。
//   - object 以外(通常運動): そのまま返す(呼び出し側で別処理)
//   - value が '○'/'◯' : 基準値(individualExercises[].defaultValue)に変換。 基準値が無ければ null
//   - value が ×・✕・x・ー・- ・空 : null (実施なし)
//   - それ以外(数値等): その値
//   mode='circle' のときは「実施なら'○'」を返す(連絡帳用)。
export const resolveIndividualExerciseValue = (slotVal, individualExercises, mode) => {
  if (!slotVal || typeof slotVal !== 'object') return undefined; // 個別運動でない
  const val = String(slotVal.value == null ? '' : slotVal.value).trim();
  const NONE = ['', '×', '✕', 'x', 'ー', '-'];
  if (mode === 'circle') {
    // ★ 明示的な「×(実施しなかった)」は割当(itemId)の有無に関わらず非表示(2026-09-02 CI単体テストが検出した実バグ修正)。
    //   従来は割当があると×でも○を返し、連絡帳に「実施した」と誤表示されていた。
    if (['×', '✕', 'x'].includes(val)) return null;
    if (NONE.includes(val) && !slotVal.itemId) return null;
    if (NONE.includes(val)) return slotVal.itemId ? '○' : null; // 空/ー は割当あり=規定値で実施の扱い
    return '○'; // 実施 → ○
  }
  if (val === '○' || val === '◯') {
    const ind = (individualExercises || []).find(x => x.itemId === slotVal.itemId);
    const dv = String((ind && ind.defaultValue) || '').trim();
    return dv || null;
  }
  if (NONE.includes(val)) return null;
  return val;
};

// 出席率(0-100)から①サービスの実施状況プルダウンの既定選択を返す。
export const monitoringStatusFromRate = (attended, rate) => {
  if (!attended) return '実施できなかった';
  if (rate != null && rate >= 100) return '実施できた';
  if (rate != null && rate >= 50) return '概ね実施できた';
  return '一部実施できなかった';
};

// 運動の「主数値」を取り出す ("10/20"→10, "15分"→15, "3往復"→3, "○"/"ー"/空→null)
export const exercisePrimaryNumber = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '○' || s === '◯' || s === 'ー' || s === '-' || s === '×') return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
};
