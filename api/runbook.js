// つむぎ 復旧手順書(運営用) — /api/runbook
// 台帳(/api/changelog)と同じBasic認証。 症状のキーワード検索と手順コード(R-xx)で対処法を引ける。
// 技術的な詳細版は docs/incident-recovery-runbook.md(リポジトリ内)を参照。
const HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>つむぎ 復旧手順書(運営用)</title>
<style>:root{color-scheme:light dark}html,body{margin:0;padding:0}</style>
<style>
  :root{
    --bg:#f7f8fb; --panel:#fff; --ink:#171a21; --ink2:#5a6072; --ink3:#8a90a2;
    --line:#e7e9f0; --accent:#4b53c4; --accent-soft:#eceef9; --warn:#c0392b; --warn-soft:#fbe9ec;
    --ok:#0f8f7e; --ok-soft:#e2f3ef; --mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    --jp:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP","Meiryo",system-ui,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{--bg:#0f1116;--panel:#171a22;--ink:#e9ebf2;--ink2:#a2a8bb;--ink3:#71778a;--line:#262a36;--accent:#8b93ee;--accent-soft:#20233a;--warn:#f0879a;--warn-soft:#2c1a20;--ok:#5fcdb6;--ok-soft:#152621}}
  :root[data-theme="light"]{--bg:#f7f8fb;--panel:#fff;--ink:#171a21;--ink2:#5a6072;--ink3:#8a90a2;--line:#e7e9f0;--accent:#4b53c4;--accent-soft:#eceef9;--warn:#c0392b;--warn-soft:#fbe9ec;--ok:#0f8f7e;--ok-soft:#e2f3ef}
  :root[data-theme="dark"]{--bg:#0f1116;--panel:#171a22;--ink:#e9ebf2;--ink2:#a2a8bb;--ink3:#71778a;--line:#262a36;--accent:#8b93ee;--accent-soft:#20233a;--warn:#f0879a;--warn-soft:#2c1a20;--ok:#5fcdb6;--ok-soft:#152621}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--jp);line-height:1.75;-webkit-font-smoothing:antialiased}
  .wrap{max-width:960px;margin:0 auto;padding:36px 20px 90px}
  header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:20px}
  .eyebrow{font-size:12px;letter-spacing:.22em;color:var(--accent);font-weight:700;margin:0 0 8px}
  h1{font-size:clamp(24px,4vw,34px);margin:0 0 6px;font-weight:800}
  .sub{color:var(--ink2);font-size:14px;margin:0}
  .rules{background:var(--warn-soft);border:1.5px solid var(--warn);border-radius:12px;padding:16px 18px;margin:20px 0}
  .rules b{color:var(--warn)}
  .rules ol{margin:8px 0 0;padding-left:20px}
  .search{margin:22px 0 8px}
  .search input{width:100%;font:inherit;font-size:15px;padding:12px 16px;border-radius:12px;border:1.5px solid var(--line);background:var(--panel);color:var(--ink)}
  .search input::placeholder{color:var(--ink3)}
  .hint{font-size:12px;color:var(--ink3);margin:6px 2px 18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:14px;position:relative;overflow:hidden}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent)}
  .code{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:800;color:#fff;background:var(--accent);border-radius:6px;padding:2px 9px;margin-right:8px;vertical-align:2px}
  .card h2{font-size:16.5px;font-weight:800;margin:0 0 4px;display:inline}
  .kw{font-size:11.5px;color:var(--ink3);margin:6px 0 10px}
  .sec{font-size:12px;font-weight:800;color:var(--ink3);letter-spacing:.06em;margin:12px 0 4px}
  .card p, .card li{font-size:13.5px;color:var(--ink2)}
  .card p b, .card li b{color:var(--ink)}
  .card ol,.card ul{margin:4px 0;padding-left:20px}
  pre{background:var(--accent-soft);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--ink)}
  .empty{text-align:center;color:var(--ink3);padding:40px;font-size:14px;display:none}
  .claude{background:var(--ok-soft);border-radius:8px;padding:8px 12px;font-size:12.5px;color:var(--ink2)}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--ink3)}
</style>
</head>
<body>
<div class="wrap">
<header>
  <p class="eyebrow">RECOVERY RUNBOOK ／ 運営用</p>
  <h1>つむぎ 復旧手順書</h1>
  <p class="sub">データが消えた・巻き戻った・おかしい時に、症状から対処手順を引くページです。手順コード(R-01等)でも検索できます。</p>
</header>

<div class="rules" data-card="1" data-text="鉄則 restore 禁止 バックアップ 復元ボタン r-00">
  <b>R-00 鉄則(必ず最初に読む)</b>
  <ol>
    <li><b>Supabase「Scheduled backups」の各行の Restore ボタンは絶対に押さない</b>(本番全体が巻き戻り全店の入力が消える)。復元は必ず「Restore to new project」(別プロジェクトに取り出す)を使う。</li>
    <li>書き込み系のSQLを流す前に、必ず退避コピーを作る(R-90の保全SQL)。</li>
    <li>異常に気づいたら端末操作を最小限にし、まず状況確認(R-91)から。</li>
    <li>判断に迷ったら Claude に「復旧手順書のR-xxをやりたい」と伝えて一緒に進める。</li>
  </ol>
</div>

<div class="search"><input id="q" type="search" placeholder="症状で検索(例: 利用者 消えた ／ 基準値 ／ 設定 戻る ／ R-01)" aria-label="検索"></div>
<p class="hint">キーワード例: 利用者が消えた / 運動 基準値 見えない / 設定が戻る / 巻き戻し / スナップショット / バックアップ / R-01〜R-92</p>

<div id="list">

<div class="card" data-text="r-01 利用者が消えた 減った 全員 削除 墓石 いなくなった 表示されない 利用者マスタ">
  <span class="code">R-01</span><h2>利用者が消えた・減った(全員/複数名)</h2>
  <p class="kw">検索ワード: 利用者が消えた・いなくなった・全員削除・墓石</p>
  <p class="sec">原因の可能性</p>
  <p>削除記録(墓石)の混入・誤った一括削除。2026-08-07の南水元事故と同型。</p>
  <p class="sec">手順</p>
  <ol>
    <li>R-90(保全)→R-91(状況確認)を実行。「利用者墓石」の数が異常に多い店舗を特定。</li>
    <li>変更ログ(アプリ内)で削除操作の記録(【削除】【一括削除】+端末名)があるか確認。<b>操作記録が無ければコード起因</b>。</li>
    <li>直近7日以内なら R-05(スナップショット復元)、それより前なら R-06(日次バックアップ)。</li>
    <li>墓石が原因の場合は<b>クラウドを直すだけでは端末の墓石で再削除される</b>。Claude に「墓石アムネスティの追加」を依頼(対象店舗+カットオフ時刻をコードに設定→デプロイ→全端末更新→書き戻しSQL)。</li>
  </ol>
  <p class="claude">Claudeへの依頼例: 「R-01。○○店の利用者が消えた。墓石の確認と復旧をお願い」</p>
</div>

<div class="card" data-text="r-02 運動 項目 基準値 整体 温浴 列 全部 消えた 見えない 提供記録 過去 記録 マル ○ 表示">
  <span class="code">R-02</span><h2>運動項目・基準値・整体の列が「全部」消えて見える</h2>
  <p class="kw">検索ワード: 運動項目が消えた・基準値が全員分消えた・過去の○が見えない</p>
  <p class="sec">まず知っておくこと</p>
  <p><b>データは消えていないことが多い。</b>基準値・過去記録は運動項目のID(ex_数字)に紐づいて保存されており、項目リストが既定(u1〜)に置き換わると「表示先の列」が無くなって全部消えたように見える。</p>
  <p class="sec">手順</p>
  <ol>
    <li>R-91で「運動項目数」「履歴件数」を確認。項目数が0や既定の11に戻っていたら本症状。</li>
    <li>変更履歴(exerciseItemsHistory)に本来のリストが残っていれば、履歴からの書き戻しSQLで復旧(2026-08-07に扇橋店で実績あり)。</li>
    <li>Claude に「R-02。○○店の運動項目を履歴から書き戻したい」と依頼(カバレッジ判定SQL→書き戻しSQL+_fieldTs刻印)。</li>
  </ol>
</div>

<div class="card" data-text="r-03 一部 利用者 基準値 だけ 消えた 空欄 規定 数値">
  <span class="code">R-03</span><h2>一部の利用者の基準値だけ消えた</h2>
  <p class="kw">検索ワード: 基準値 一部 消えた・特定の利用者だけ空欄</p>
  <ol>
    <li>R-05(7日以内)または R-06(それより前)で復旧素材を取得。</li>
    <li>Claude に「R-03。バックアップから基準値の合成SQLを作って。<b>今空のところだけ埋めて、入力済みは上書きしない条件で</b>」と依頼。</li>
  </ol>
</div>

<div class="card" data-text="r-04 設定 事業所情報 項目 管理 ケアマネ 消えた 戻る 巻き戻る 元に戻る 各種設定 整体 担当者 保存">
  <span class="code">R-04</span><h2>各種設定の内容が消えた・古い内容に巻き戻った</h2>
  <p class="kw">検索ワード: 設定が消えた・保存したのに戻る・事業所情報・整体担当者</p>
  <ol>
    <li>まず全端末「今すぐ更新」(古いアプリの端末が古い値を書き戻すのが典型原因)。</li>
    <li>それでも戻る場合は R-05 のスナップショットで直前の値を確認し、該当フィールドだけ書き戻し(_fieldTs刻印つき)。</li>
    <li>Claude に「R-04。○○店の設定が巻き戻る。フィールドは□□」と依頼。</li>
  </ol>
  <p>※ 少量なら画面から手入力で直すのが最速のこともある(直した内容は項目単位保護で守られる)。</p>
</div>

<div class="card" data-text="r-05 スナップショット 20分 7日 巻き戻し 復元 戻したい 直近 app_state_snapshots">
  <span class="code">R-05</span><h2>直近7日以内の状態に戻したい(20分スナップショット)</h2>
  <p class="kw">検索ワード: スナップショット・20分・昨日に戻したい</p>
  <p>20分ごとの自動スナップショットが7日分ある(app_state_snapshots)。<b>丸ごとではなく必要なフィールドだけ</b>戻すのが原則。</p>
  <pre>-- 1) 時点を探す(事故「直前」を選ぶ)
select id, version, taken_at,
  jsonb_array_length(coalesce(data->'patients','[]'::jsonb)) as 利用者数
from app_state_snapshots where key='store_XXXX' order by taken_at desc limit 30;

-- 2) 例: 利用者だけ書き戻す(実行前に R-90 の保全を!)
update app_state a
set data = jsonb_set(a.data, '{patients}', s.data->'patients'),
    version = coalesce(a.version,0)+1
from app_state_snapshots s where s.id = &lt;ID&gt; and a.key = s.key;</pre>
</div>

<div class="card" data-text="r-06 バックアップ 日次 restore to new project 新プロジェクト csv 7日より前 復元">
  <span class="code">R-06</span><h2>7日より前に戻したい(日次バックアップから取り出す)</h2>
  <p class="kw">検索ワード: バックアップ・日次・新プロジェクト・CSV</p>
  <ol>
    <li>Supabase → Database → Backups → <b>「Restore to new project」タブ</b>(BETA)。</li>
    <li>事故<b>前</b>の時刻の行の Restore(このタブ内は安全: 別プロジェクトが作られるだけ)。名前は tsumugi-restore-日付、パスワードは自動生成でメモ。</li>
    <li>新プロジェクトのSQL Editorで:<br><code>select key, version, data::text as data from app_state order by key;</code><br>→ Export → Download CSV → Googleドライブ&gt;Claude&gt;restore/ に置く。</li>
    <li>Claude に「R-06。CSVを置いた。○○の書き戻しSQLを作って」と依頼。</li>
    <li>復旧確認後、新プロジェクトは削除(Settings→General→Delete project。プロジェクト名を入力して確定)。</li>
  </ol>
</div>

<div class="card" data-text="r-07 restore 押してしまった 誤操作 本番 巻き戻った バックアップ復元 やってしまった">
  <span class="code">R-07</span><h2>誤って本番の Restore を押してしまった</h2>
  <p class="kw">検索ワード: Restore 押した・本番が巻き戻った</p>
  <ol>
    <li><b>それ以上 Restore しない。</b>被害を広げないことが最優先。</li>
    <li>即座に R-90(保全)を実行し、現時点を退避。</li>
    <li>端末はしばらく触らない(端末に残る新しいデータが自動同期で戻ってくることがある)。</li>
    <li>Claude に「R-07。○時○分のバックアップをRestoreしてしまった」と即連絡。バックアップ時刻〜Restore時刻の欠落分を端末側データ・スナップショットから合成する。</li>
  </ol>
</div>

<div class="card" data-text="r-08 復旧後 チェックリスト 確認 終わったら">
  <span class="code">R-08</span><h2>復旧後のチェックリスト</h2>
  <ul>
    <li>対象店舗の端末で「今すぐ更新」→ 利用者数・基準値・過去記録の表示確認</li>
    <li>R-91を再実行し他店舗に異常が無いか確認</li>
    <li>スナップショット(R-92)が動いているか確認</li>
    <li>変更管理台帳(/api/changelog)に記録されているか確認</li>
    <li>復旧用の新プロジェクトを削除したか</li>
  </ul>
</div>

<div class="card" data-text="r-90 保全 退避 コピー バックアップ 最初">
  <span class="code">R-90</span><h2>保全SQL(書き込み前に必ず)</h2>
  <pre>create table if not exists app_state_rescue_YYYYMMDD as select * from app_state;
select count(*), now() from app_state_rescue_YYYYMMDD;</pre>
  <p>※ YYYYMMDD は当日の日付に置き換え(例: app_state_rescue_20260807)。</p>
</div>

<div class="card" data-text="r-91 状況確認 全店 サマリ 一覧 調査 何が起きた">
  <span class="code">R-91</span><h2>状況確認SQL(全店サマリ・読み取りのみ)</h2>
  <pre>select key,
  jsonb_array_length(coalesce(data->'systemSettings'->'exerciseItems','[]'::jsonb)) as 運動項目数,
  jsonb_array_length(coalesce(data->'systemSettings'->'exerciseItemsHistory','[]'::jsonb)) as 履歴件数,
  jsonb_array_length(coalesce(data->'patients','[]'::jsonb)) as 利用者数,
  (select count(*) from jsonb_array_elements(coalesce(data->'patients','[]'::jsonb)) p
     where p->'plannedExercises' is not null and p->'plannedExercises' &lt;&gt; '{}'::jsonb) as 基準値あり,
  (select count(*) from jsonb_object_keys(coalesce(data->'deletedIds'->'patients','{}'::jsonb))) as 利用者墓石
from app_state where key like 'store_%' order by key;</pre>
</div>

<div class="card" data-text="r-92 スナップショット 設定 pg_cron 20分 再設定 動いていない">
  <span class="code">R-92</span><h2>20分スナップショットの確認・再設定</h2>
  <pre>-- 動作確認(直近が20分以内ならOK)
select key, version, taken_at from app_state_snapshots order by taken_at desc limit 15;</pre>
  <p>止まっていたら Claude に「R-92。スナップショットを再設定して」と依頼(pg_cron設定SQLを提供)。</p>
</div>

</div>
<p class="empty" id="empty">該当する手順が見つかりません。キーワードを変えるか、Claude に症状をそのまま伝えてください。</p>

<footer>
  つむぎ 復旧手順書 ／ 詳細な技術手順: リポジトリ docs/incident-recovery-runbook.md ／ 変更管理台帳: /api/changelog<br>
  2026-08-07 南水元データ消失事故の復旧実績に基づく。 更新はデプロイと同時に反映。
</footer>
</div>
<script>
(function(){
  var q=document.getElementById('q'),cards=[].slice.call(document.querySelectorAll('[data-card],#list .card')),empty=document.getElementById('empty');
  function norm(s){return (s||'').toLowerCase().replace(/[\\u30a1-\\u30f6]/g,function(m){return String.fromCharCode(m.charCodeAt(0)-96)});}
  q.addEventListener('input',function(){
    var terms=norm(q.value).split(/\\s+/).filter(Boolean),shown=0;
    cards.forEach(function(c){
      var t=norm(c.getAttribute('data-text')+' '+c.textContent);
      var ok=terms.every(function(w){return t.indexOf(w)!==-1});
      c.style.display=ok?'':'none'; if(ok)shown++;
    });
    empty.style.display=shown?'none':'block';
  });
})();
</script>
</body>
</html>`;

export default function handler(req, res) {
  const USER = process.env.RUNBOOK_USER || process.env.CHANGELOG_USER || 'tsumugi';
  const PASS = process.env.RUNBOOK_PASS || process.env.CHANGELOG_PASS || 'hennkoukiroku';
  const h = req.headers.authorization || '';
  let ok = false;
  if (h.startsWith('Basic ')) { try { const dec = Buffer.from(h.slice(6),'base64').toString('utf8'); const i = dec.indexOf(':'); if (i!==-1 && dec.slice(0,i)===USER && dec.slice(i+1)===PASS) ok=true; } catch(e){} }
  if (!ok) { res.setHeader('WWW-Authenticate','Basic realm="tsumugi", charset="UTF-8"'); res.setHeader('content-type','text/plain; charset=utf-8'); res.status(401).send('認証が必要です / Authentication required'); return; }
  res.setHeader('content-type','text/html; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-robots-tag','noindex, nofollow, noarchive'); res.status(200).send(HTML);
}
