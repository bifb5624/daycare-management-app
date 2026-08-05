# つむぎ（Tsumugi）ロゴ仕様書

## 1. 正式データ

この仕様書では、添付画像を**正式なマスター画像**として扱います。  
形状を生成AIやCSSだけで描き直すと、握手部分の指の本数や曲線が変化しやすいため、実装時は次の画像をそのまま使用してください。

- `tsumugi-logo-reference.png`：ユーザー提供画像を変更せず保存した基準画像
- `tsumugi-logo-full-transparent.png`：背景透過・ロゴ＋文字
- `tsumugi-mark-transparent.png`：背景透過・握手マークのみ
- `tsumugi-app-icon-1024.png`：アプリアイコン用
- `tsumugi-app-icon-512.png`
- `tsumugi-app-icon-256.png`
- `tsumugi-app-icon-128.png`

## 2. ロゴの構成

- 一本の連続線による握手
- 左右に糸が流れるようなループ
- 左下の握り込み：丸い指の輪郭が4つ
- 右下の手の甲側：指の区切りを含め、5本の指として読める形
- 上段日本語ロゴタイプ：`つむぎ`
- 下段英字ロゴタイプ：`Tsumugi`
- 背景：白
- 基本配置：マークを上、文字を下に中央揃え

## 3. ブランドの意味

事業所・ご家族・ケアマネージャー・その他関係者が、それぞれの立場から一人の利用者を支える関係性を表現しています。  
一本の線は「糸」と「つながり」、握手は「信頼」と「支え合い」、左右のループは「関係が途切れず続くこと」を意味します。

## 4. カラー

| 用途 | 色 |
|---|---|
| 糸の開始色 | `#54A77B` |
| 緑 | `#91B64E` |
| 黄 | `#E2B62E` |
| オレンジ | `#F39A3E` |
| コーラル | `#F46F67` |
| ピンク | `#E6608F` |
| 紫 | `#A46FD1` |
| 青 | `#63A9E8` |
| 日本語文字 | `#303033` |
| 英字文字 | `#7EAD54` |
| 背景 | `#FFFFFF` |

グラデーションは左から右へ、概ね次の順番で遷移します。

```css
linear-gradient(
  90deg,
  #54A77B 0%,
  #91B64E 16%,
  #E2B62E 31%,
  #F39A3E 46%,
  #F46F67 60%,
  #E6608F 73%,
  #A46FD1 86%,
  #63A9E8 100%
);
```

## 5. 実装ルール

### Webヘッダー

```html
<img
  src="/brand/tsumugi-logo-full-transparent.png"
  alt="つむぎ Tsumugi"
  class="tsumugi-logo"
/>
```

```css
.tsumugi-logo {
  display: block;
  width: min(320px, 70vw);
  height: auto;
  object-fit: contain;
}
```

### マークのみ

```html
<img
  src="/brand/tsumugi-mark-transparent.png"
  alt=""
  aria-hidden="true"
  class="tsumugi-mark"
/>
```

### アプリアイコン

- iOS／PWA／SNS：`tsumugi-app-icon-1024.png`
- favicon生成元：`tsumugi-app-icon-512.png`
- アイコン内には原則として文字を入れず、握手マークのみを使用
- 角丸処理はOS側に任せる
- 独自に円形へ切り抜かない

## 6. 余白

ロゴの周囲には、握手マークの線幅の**4倍以上**の余白を確保してください。  
文字付きロゴでは、上下左右にロゴ全高の**10%以上**の余白を推奨します。

## 7. 推奨サイズ

- Webヘッダー：横幅 180〜320px
- LPヒーロー：横幅 320〜560px
- 印刷：横幅 30mm以上
- マークのみ：32px以上
- アプリアイコンの元データ：1024×1024px

32px未満では握手の指が潰れやすいため、16pxのfaviconでは簡略化版を別途作るか、512pxアイコンを縮小して視認性を確認してください。

## 8. 禁止事項

- 握手部分の指の本数を変更しない
- 左下の4つの丸い指を減らさない
- 右下の5本指の構造を省略しない
- 縦横比を変更しない
- グラデーションの順序を反転しない
- ドロップシャドウ、立体効果、縁取りを加えない
- 白背景以外で使用する際、視認性を損なう背景を使わない
- 生成AIでロゴを再生成して正式データとして置き換えない

## 9. Claude Codeへの指示文

以下をそのままClaude Codeへ渡せます。

```text
このプロジェクトの正式ロゴは、brandフォルダにある画像ファイルを使用してください。
ロゴ形状をSVG、CSS、Canvas、生成AIで描き直さないでください。

使用ファイル：
- 通常ロゴ：/brand/tsumugi-logo-full-transparent.png
- マークのみ：/brand/tsumugi-mark-transparent.png
- アプリアイコン：/brand/tsumugi-app-icon-1024.png

ロゴは縦横比を維持し、object-fit: contain で表示してください。
通常ロゴの推奨幅は180〜320px、LPヒーローでは最大560pxです。
周囲にはロゴ全高の10%以上の余白を確保してください。

ロゴの意味は、事業所・家族・ケアマネージャー・その他関係者が、
一本の糸のようにつながり、一人の利用者を支えることです。
左下の丸い指は4つ、右下は5本の指として読める形が正式仕様です。
画像を改変、再描画、色変更、変形しないでください。
```

## 10. ファイル配置例

```text
public/
└── brand/
    ├── tsumugi-logo-reference.png
    ├── tsumugi-logo-full-transparent.png
    ├── tsumugi-mark-transparent.png
    ├── tsumugi-app-icon-1024.png
    ├── tsumugi-app-icon-512.png
    ├── tsumugi-app-icon-256.png
    └── tsumugi-app-icon-128.png
```
