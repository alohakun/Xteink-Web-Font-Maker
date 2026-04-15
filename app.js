import FreeTypeInit from "https://cdn.jsdelivr.net/npm/freetype-wasm@0/dist/freetype.js";

// グローバルステート
let ft = null; // FreeTypeライブラリのインスタンス
let activeFont = null; // 現在アクティブなフォントフェイス

// --- FreeType の初期化 ---
試す {
  ft = await FreeTypeInit();
  // 診断情報が存在する場合は更新する
  試す {
    const di = document.getElementById("diagnostics");
    if (di) di.querySelector(".ft").textContent = "読み込み済み";
  } catch (e) {}
} catch (err) {
  console.error("FreeTypeの初期化に失敗しました:", err);
  アラート(
    「重大なエラー：FreeTypeライブラリを読み込めませんでした。ブラウザのコンソールを確認してください。」
  );
  throw new Error("FreeType の初期化に失敗しました");
}

// --- ヘルパー関数 ---

// サーバー送信用の API ベース URL。ここに Cloudflare Tunnel のホスト名を設定してください。
const API_BASE = "https://apixtgallery.lakafior.com";

/**
 * 文字が空白文字または不可視文字であるかどうかをチェックするヘルパー関数。
 * FreeType が .notdef グリフを返す場合でも、これらの文字は空白としてレンダリングされる必要があります。
 */
// 縦書き時の文字置換マップ（横向き文字→縦向きグリフ）
// 縦書き時に90度回転が必要な文字セット
const VERTICAL_ROTATE_CHARS = new Set([
  0x30FC、// ー
  0x2015、// ―
  0xFF0D、//－
  0x007E、// ~
  0xFF5E、// ～
  0x2026、// …
  0x2025、// բ
]);

// 縦書き時に位置を句右下にずらす括文字（読点・弧）
const VERTICAL_SHIFT_CHARS = new Set([
  0x3001、//、
  0x3002、//。
  0xFF08、//（
  0xFF09, // ）
  0x300C、//「
  0x300D、// 」
  0x300E、// 『
  0x300F、// 』
]);

// 縦書き時のグリフ交換マップ（横向き文字→縦向きグリフ）
const VERTICAL_CHAR_MAP = new Map([
  [0x30FC, 0xFE31], // ー → ︱
  [0x2015, 0xFE31], // ― → ︱
  [0xFF0D, 0xFE31], // － → ︱
  [0xFF5E, 0xFE34], // ～ → ︴
  [0x2026, 0xFE19], // … → ︙
  [0x2025, 0xFE19], // ՝ → ︙
]);

function getVerticalCharCode(charCode) {
  return VERTICAL_CHAR_MAP.get(charCode) ?? charCode;
}

function isWhitespaceOrInvisible(charCode) {
  // 空白としてレンダリングされるべき一般的な空白文字と不可視文字
  const whitespaceChars = new Set([
    0x0020、// スペース
    0x00a0、// 改行なしスペース
    0x1680、// オガム文字のスペースマーク
    0x2000、
    0x2001、
    0x2002、
    0x2003、
    0x2004、
    0x2005、// EN QUAD、EM QUAD、EN SPACE、EM SPACE、3 パー EM SPACE、4 パー EM SPACE
    0x2006、
    0x2007、
    0x2008、
    0x2009、
    0x200a、// 6パーエムのスペース、数字のスペース、句読点のスペース、細いスペース、髪の毛のスペース
    0x202f、// 狭い改行なしスペース
    0x205f、// 中程度の数学的空間
    0x3000、// 表意文字スペース（CJK 全角スペース） - 中国語のテキストで非常によく使われます！
    0x0009、// TAB
    0x000a、// 改行
    0x000b、// 垂直タブ
    0x000c、// フォームフィード
    0x000d、// キャリッジリターン
    0x0085、// 次の行
    0x00ad、// ソフトハイフン
    0x200b、// 幅ゼロのスペース
    0x200c、// 幅ゼロの非結合子
    0x200d、// 幅ゼロの結合子
    0x2060、// ワードジョイナー
    0xfeff、// 幅ゼロの改行なしスペース
  ]);
  return whitespaceChars.has(charCode);
}

function getFreetypeLoadFlags() {
  const isAntiAlias = document.getElementById("chkRenderAntiAlias").checked;
  const isGridFit = document.getElementById("chkRenderGridFit").checked;

  let flags = ft.FT_LOAD_RENDER;

  if (!isGridFit) {
    flags |= ft.FT_LOAD_NO_HINTING;
  }

  if (isAntiAlias) {
    flags |= ft.FT_LOAD_TARGET_NORMAL; // グレースケールアンチエイリアシング
  } それ以外 {
    flags |= ft.FT_LOAD_TARGET_MONO; // 1ビットモノクロレンダリング
  }

  フラグを返す。
}

/**
 * FreeTypeビットマップのピクセルを黒としてレンダリングするかどうかを決定します。
 * キリル文字や複雑なグリフのサポートを向上させるため、RGB輝度とアルファチャンネルの両方をチェックします。
 * @param {Uint8ClampedArray} data - RGBAピクセルデータ
 * @param {number} index - ピクセルの開始インデックス（Rチャンネル）
 * @param {number} threshold - しきい値 (0～255)
 * @returns {boolean} - ピクセルを黒くレンダリングする場合はtrue
 */
function shouldRenderPixel(data, index, threshold) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];

  // FreeTypeビットマップの場合、アルファチャンネルには通常、カバレッジ/強度が含まれます
  // ただし、一部のフォント（特にキリル文字）では、RGB値も確認する必要があります。
  //
  // 戦略：
  // 1. プライマリチェック：アルファチャンネル（ほとんどのフォントはここにグリフデータを配置します）
  // 2. フォールバックチェック: アルファが中程度の場合、RGBが暗いかどうかもチェックします
  // これは、グリフデータがRGBチャンネルにあるフォントに役立ちます

  // まずアルファ値をチェックします（標準的なFreeTypeアンチエイリアス処理済みグリフ）
  if (a > しきい値) {
    trueを返します。
  }

  // RGBチェック用の輝度（知覚される明るさ）を計算する
  // 標準輝度式を使用: 0.299*R + 0.587*G + 0.114*B
  const 輝度 = 0.299 * r + 0.587 * g + 0.114 * b;

  // フォールバック: ピクセルにアルファ値があり、かつ暗い場合は、それをレンダリングする
  // これは、データがRGBであるキリル文字やその他のグリフを検出します
  // より緩やかな設定にするには、アルファ閾値を低く設定します（閾値/4）
  if (a > threshold / 4 && brightness < 255 - threshold) {
    trueを返します。
  }

  falseを返す。
}

/**
 * 代表的な文字を用いて最適なフォントサイズを測定します。
 * 幅には「M」（通常は最も幅の広いラテン文字）を、高さには「Å」（アクセント付きの背の高い文字）を使用します。
 * @param {number} fontSize - フォントサイズ（ピクセル単位）
 * @returns {{width: number, height: number}} - ピクセル単位で測定された寸法
 */
function measureOptimalFontDimensions(fontSize) {
  if (!ft || !activeFont) {
    return { width: fontSize, height: fontSize };
  }

  試す {
    ft.SetFont(activeFont.family_name, activeFont.style_name);
    ft.SetPixelSize(0, fontSize);

    // 代表的な横長の文字をスキャンします
    // ワイド: W、M、@、%、#、m、w
    // 身長: Å、Ä、Ö、É、Ë、d、b、h、l
    const testChars = [
      0x0057、
      0x004d、
      0x0040、
      0x0025、
      0x0023、
      0x006d、
      0x0077、// WM @ % # mw
      0x00c5、
      0x00c4、
      0x00d6、
      0x00c9、
      0x00cb、// Å Ä Ö É Ë
      0x0064、
      0x0062、
      0x0068、
      0x006c、// dbhl
    ];

    const loadFlags = ft.FT_LOAD_RENDER | ft.FT_LOAD_TARGET_MONO;
    const glyphs = ft.LoadGlyphs(testChars, loadFlags);

    let maxWidth = 0;
    let maxHeight = 0;
    let widestChar = "";
    let tallestChar = "";

    // すべてのグリフをスキャンし、最大ビットマップ幅と最大ビットマップ行数を見つける
    for (const [charCode, glyph] of glyphs.entries()) {
      const char = String.fromCharCode(charCode);

      // bitmap.width（実際にレンダリングされたピクセル数）を確認します
      if (glyph.bitmap && glyph.bitmap.width > 0) {
        if (glyph.bitmap.width > maxWidth) {
          maxWidth = glyph.bitmap.width;
          最も幅の広い文字 = 文字;
        }
      }

      // bitmap.rows（実際にレンダリングされた高さ）を確認する
      if (glyph.bitmap && glyph.bitmap.rows > 0) {
        if (glyph.bitmap.rows > maxHeight) {
          maxHeight = glyph.bitmap.rows;
          tallestChar = char;
        }
      }
    }

    計測幅 = maxWidth;
    計測された高さ = 最大高さ;
    let widthChar = widestChar;
    let heightChar = tallestChar;

    // C# の最小値 5 ピクセルを適用し、必要に応じて fontSize にフォールバックします。
    measuredWidth = Math.max(5, measuredWidth || fontSize);
    measuredHeight = Math.max(5, measuredHeight || fontSize);

    console.log(
      `📏 fontSize=${fontSize}px で測定したフォントサイズ (スキャンした文字数 ${testChars.length}):`,
      {
        幅: measuredWidth、
        高さ: measuredHeight、
        widestChar: widthChar || "fallback",
        tallestChar: heightChar || "fallback",
        スキャンされたグリフ: グリフのサイズ、
      },
    );

    return { width: measuredWidth, height: measuredHeight };
  } catch (e) {
    console.warn("最適なフォント寸法の測定に失敗しました:", e);

    return { width: fontSize, height: fontSize };
  }
}

function computeBaselineOffset(boxHeight, lineSpacing) {
  if (boxHeight <= 0) return 0;

  const contentHeight = Math.max(0, boxHeight - lineSpacing);
  const baseBaseline = Math.round(contentHeight * 0.75);
  const spacingOffset = Math.floor(lineSpacing / 2);
  let baseline = baseBaseline + spacingOffset;

  ベースラインが0未満の場合、0を返す。
  if (baseline > boxHeight) return boxHeight;
  ベースラインを返す。
}

const optical_offsets = {
  // ============================================
  // OKRĄGŁE ZNAKI - 情報を得る
  // ============================================
  // Okrągłe litery mają "optyczną masę" w środku、więc geometryczne
  // wycentrowanie sprawia、że wydają się za daleko.プシェスワミ・ジェ・レウォ。
  O: -0.1、
  Q: -0.1、
  C: -0.09、
  G: -0.09、
  o: -0.1、
  q: -0.1、
  c: -0.09、
  g: -0.09、
  0: -0.1、
  6: -0.08、
  8: -0.08、
  9: -0.08、

  // Półokrągłe - średnie przesunięcie w lewo
  D: -0.06、
  d: -0.06、
  S: -0.05、
  s: -0.05、
  3: -0.06、
  5: -0.05、
  2: -0.04、

  // ============================================
  // ZNAKI Z "DACHEM" - przesunięcie w prawo
  // ============================================
  // 文学を読み解く
  // ポッドソボー。 Przesunięcie w prawo pozwala następnej literze wypełnić tę lukę。
  T: 0.07、
  Y: 0.06、
  V: 0.06、
  W: 0.05、
  A: 0.04、
  y: 0.05、
  v: 0.05、
  w: 0.04、
  7: 0.06、

  // ============================================
  // WĄSKIE ZNAKI - ニュートラルなラブ・ミニマル
  // ============================================
  // ウォンスキー ズナキ ウィグルダジョン ナジュレピエ グディ シン ウィセントロワネ。
  // 問題 z "ill" nie jest do rozwiązania przez offset - to kwestia
  // szerokości boxa、której nie możemy zmienić.
  I: 0、
  l: 0、
  i: 0、
  1:0、
  "!": 0、
  "|": 0、
  t: 0、
  f: 0、
  j: 0、
  r: 0, // 'r' jest wąskie z prawej strony、ale lepiej wycentrowane

  // ============================================
  // ズナキ・ゾトワルテ・プラウニ・ストロニト
  // ============================================
  // Te znaki mają dużo "powietrza" z prawej, więc lekko w prawo
  J: 0.05、
  a: 0.02、
  e: 0.02、
  u: 0.02、

  // ============================================
  // NAWIASY I ZNAKI INTERPUNKCYJNE
  // ============================================
  // Otwierające - silnie w lewo (wtulają się)
  "(": -0.12、
  "[": -0.12、
  "{": -0.12、

  // ザミカヨンチェ - シルニー w プラウォ (ウィピチャヨン)
  ")": 0.12、
  "]": 0.12、
  "}": 0.12、

  // Cudzysłowy i apostrofy - asymetryczne
  // Używamy unikalnych znaków typograficznych jako kluczy
  "'": -0.08, // Lewy pojedynczy cudzysłów
  "'": 0.08, // Prawy pojedynczy cudzysłów (i apostrof)
  "ã": -0.08, // ポジェディンツィ・クジスウ・ドルニー
  """: -0.08, // レヴィ podwójny cudzysłów
  """: 0.08, // プラウィ podwójny cudzysłów
  "``": -0.08, // ポドウォジュニー クジスウ ドルニー
  "'": 0, // Neutralny (prosty) apostrof - często używany jako prawy, więc może być 0.08, ale 0 jest bezpieczniejsze
  '"': 0, // 中立 (プロスティ) cudzysłów - wycentrowany

  // パンクサイクルを中断する - レッスンを開始する
  ".": -0.02、
  ",": -0.02、
  ":": -0.02、
  ";": -0.02、

  // ============================================
  // ZNAKI SYMETRYCZNE - ニュートラル (0)
  // ============================================
  // 文学的なマジポドブナ "masę optyczną" po obu stronach
  B: 0、
  E: 0、
  F: 0、
  H: 0、
  K: 0、
  L: 0、
  M: 0、
  N: 0、
  P: 0、
  R: 0、
  U: 0、
  X: 0、
  Z: 0、
  b: 0、
  h: 0、
  k: 0、
  m: 0、
  n: 0、
  p: 0、
  x: 0、
  z: 0、
  4:0、

  // Znaki matematyczne i specjalne - wycentrowane
  "-": 0、
  "+": 0、
  "=": 0,
  "*": 0、
  "/": 0、
  "\\": 0、
  "#": 0、
  "&": 0、
  "%": 0、
  $: 0、
  "@": 0、
  「？」：0、
  "^": 0、
  _: 0、
  "~": 0、
  "`": 0、
  "<": 0、
  ">": 0、
};

// Funkcja pomocnicza do bezpiecznego pobierania offsetu
function getOpticalOffset(char) {
  return optical_offsets[char] ?? 0;
}

const narrowVerticals = new Set([
  「l」
  "私"、
  「t」
  「f」
  「j」
  "私"、
  「J」
  「T」
  「F」
  「１」
  「！」
  "|",
]);

function getOpticalDx(char, bitmapWidth, boxWidth, isFirstCharInLine) {
  const centeredDx = Math.floor((boxWidth - bitmapWidth) / 2);

  // 基本文字をチェックして、アクセント付き文字を処理するために文字を正規化する
  const normalizedChar = char.normalize("NFD").replace(/[̀-͡]/g, "");

  // 1. オフセットマップからベースシフトを取得します
  const baseShiftFraction = optical_offsets[normalizedChar] || 0.0;
  let dx = centeredDx + Math.round(boxWidth * baseShiftFraction);

  // 2. 擬似カーニングルールを適用する（仕様書セクション5）
  if (!isFirstCharInLine && narrowVerticals.has(normalizedChar)) {
    const kerningShift = Math.round(boxWidth * -0.03); // 左に3%シフト
    dx += kerningShift;
  }

  dxを返す;
}

/**
 * FreeTypeを使用して、グリフプレビューキャンバスに1文字をレンダリングします。
 */
function renderGlyphToCanvas(char) {
  const onScreenCanvas = document.getElementById("glyphCanvas");
  const onScreenCtx = onScreenCanvas.getContext("2d");

  // 1. すべての設定を取得する
  const fontSize =
    parseInt(document.getElementById("fontSize").value, 10) || 28;
  const charSpacing =
    parseInt(document.getElementById("charSpacing").value, 10) || 0;
  const lineSpacing =
    parseInt(document.getElementById("lineSpacing").value, 10) || 0;
  const threshold =
    parseInt(document.getElementById("lightnessThreshold").value, 10) || 127;
  const isVerticalFont = document.getElementById("isVerticalFont").checked;
  const shouldRenderBorder = document.getElementById("chkRenderBorder").checked;
  const useOpticalAlign = document.getElementById("chkOpticalAlign").checked;

  // より正確なレンダリングのために、fontSize の代わりに計測された幅を使用します
  const dimensions = measureOptimalFontDimensions(fontSize);
  const boxWidth = dimensions.width + charSpacing;
  const boxHeight = dimensions.height + lineSpacing;

  onScreenCtx.fillStyle = "#fff";
  onScreenCtx.fillRect(0, 0, onScreenCanvas.width, onScreenCanvas.height);

  if (boxWidth <= 0 || boxHeight <= 0) return;

  // 2. 実際のボックス寸法でオフスクリーンキャンバスを作成します
  const offScreenCanvas = document.createElement("canvas");
  offScreenCanvas.width = boxWidth;
  offScreenCanvas.height = boxHeight;
  const ctx = offScreenCanvas.getContext("2d");

  // 3. グリフをオフスクリーンキャンバスにレンダリングする
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  if (shouldRenderBorder) {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, ctx.canvas.width - 1, ctx.canvas.height - 1);
  }

  if (ft && activeFont) {
    ft.SetFont(activeFont.family_name, activeFont.style_name);
    ft.SetPixelSize(0, fontSize);
    const loadFlags = getFreetypeLoadFlags();
    const glyphs = ft.LoadGlyphs([char.charCodeAt(0)], loadFlags);
    if (glyphs.has(char.charCodeAt(0))) {
      const glyph = glyphs.get(char.charCodeAt(0));
      const bitmap = glyph.bitmap;
      const charCode = char.charCodeAt(0);
      もし （
        bitmap.width > 0 &&
        bitmap.rows > 0 &&
        ビットマップ.画像データ &&
        !isWhitespaceOrInvisible(charCode)
      ) {
        let dx = Math.floor((offScreenCanvas.width - bitmap.width) / 2);

        if (useOpticalAlign) {
          // 単一グリフのプレビューの場合、行の最初の文字として扱います（カーニングなし）

          dx = getOpticalDx(char, bitmap.width, boxWidth, true);
        }

        const baseline = computeBaselineOffset(boxHeight, lineSpacing);
        const dy = baseline - glyph.bitmap_top;

        const sourceData = bitmap.imagedata.data;
        ctx.fillStyle = "#000";
        for (let y = 0; y < bitmap.rows; y++) {
          for (let x = 0; x < bitmap.width; x++) {
            const i = (y * bitmap.width + x) * 4;
            if (shouldRenderPixel(sourceData, i, threshold)) {
              ctx.fillRect(dx + x, dy + y, 1, 1);
            }
          }
        }
      }
    }
  }

  // 4. オフスクリーンキャンバスを、拡大縮小および回転させてオンスクリーンキャンバスに描画します。
  onScreenCtx.imageSmoothingEnabled = false;

  const scale = Math.min(
    onScreenCanvas.width / boxWidth、
    onScreenCanvas.height / boxHeight、
  );
  const destWidth = boxWidth * scale;
  const destHeight = boxHeight * scale;
  const destX = (onScreenCanvas.width - destWidth) / 2;
  const destY = (onScreenCanvas.height - destHeight) / 2;

  if (isVerticalFont) {
    onScreenCtx.save();
    onScreenCtx.translate(onScreenCanvas.width / 2, onScreenCanvas.height / 2);
    onScreenCtx.rotate((-90 * Math.PI) / 180);
    onScreenCtx.translate(
      -onScreenCanvas.width / 2、
      -onScreenCanvas.height / 2、
    );
  }

  onScreenCtx.drawImage(offScreenCanvas, destX, destY, destWidth, destHeight);

  if (isVerticalFont) {
    onScreenCtx.restore();
  }
}

/**
 * FreeTypeを使用して、プレビューテキストをメインのプレビューキャンバスにレンダリングします。
 */
function renderPreviewText() {
  const canvas = document.getElementById("previewCanvas");
  const ctx = canvas.getContext("2d");

  if (canvas.width !== canvas.clientWidth) {
    canvas.width = canvas.clientWidth;
  }

  const previewText = document.getElementById("previewText").value;
  const fontSize =
    parseInt(document.getElementById("fontSize").value, 10) || 28;
  const charSpacing =
    parseInt(document.getElementById("charSpacing").value, 10) || 0;
  const lineSpacing =
    parseInt(document.getElementById("lineSpacing").value, 10) || 0;
  const threshold =
    parseInt(document.getElementById("lightnessThreshold").value, 10) || 127;
  const shouldRenderBorder = document.getElementById("chkRenderBorder").checked;
  const useOpticalAlign = document.getElementById("chkOpticalAlign").checked;

  // より正確なレンダリングのために、fontSize の代わりに計測された幅を使用します
  const dimensions = measureOptimalFontDimensions(fontSize);
  const boxWidth = dimensions.width + charSpacing;
  const boxHeight = dimensions.height + lineSpacing;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ft || !activeFont || boxHeight <= 0) return;

  ft.SetFont(activeFont.family_name, activeFont.style_name);
  ft.SetPixelSize(0, fontSize);

  const loadFlags = getFreetypeLoadFlags();
  const isVerticalPreview = document.getElementById("isVerticalFont").checked;
  const baseCodes = [...new Set(previewText.split("").map((c) => c.charCodeAt(0)))];
  // 縦書き時は縦向きグリフのコードも追加ロード
  const extraCodes = isVerticalPreview ? [...new Set(VERTICAL_CHAR_MAP.values())] : [];
  const charCodes = [...new Set([...baseCodes, ...extraCodes])];
  const glyphs = ft.LoadGlyphs(charCodes, loadFlags);

  const lines = previewText.split(/\r?\n/);

  if (isVerticalPreview) {
    // 縦書きプレビュー: 右から左へ列、上から下へ文字
    // テキストを全文字のリストに展開
    const allChars = previewText.replace(/\r?\n/g, "").split("");
    let colX = canvas.width - boxWidth;
    let charY = 0;

    for (let i = 0; i < allChars.length; i++) {
      const char = allChars[i];
      const charCode = char.charCodeAt(0);

      // 列が溢れたら次の列へ（右→左）
      if (charY + boxHeight > canvas.height) {
        charY = 0;
        colX -= boxWidth;
      }
      (colX < 0) の場合、処理を中断します。

      // 縦書き用グリフに置き換え
      const renderCode = (VERTICAL_CHAR_MAP.has(charCode) && glyphs.has(VERTICAL_CHAR_MAP.get(charCode)))
        ? VERTICAL_CHAR_MAP.get(charCode) : charCode;

      if (!glyphs.has(renderCode)) { charY += boxHeight; continue; }

      if (shouldRenderBorder) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.strokeRect(colX + 0.5, charY + 0.5, boxWidth - 1, boxHeight - 1);
      }

      const glyph = glyphs.get(renderCode);
      const bitmap = glyph.bitmap;

      if (bitmap.width > 0 && bitmap.rows > 0 && bitmap.imagedata && !isWhitespaceOrInvisible(charCode)) {
        const sourceData = bitmap.imagedata.data;
        ctx.fillStyle = "#000";

        if (VERTICAL_ROTATE_CHARS.has(charCode)) {
          // 回転が必要な文字（グリフ交換がない場合のフォールバック）
          const offC = document.createElement("canvas");
          offC.width = bitmap.width;
          offC.height = bitmap.rows;
          const offCtx = offC.getContext("2d");
          offCtx.fillStyle = "#000";
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                offCtx.fillRect(x, y, 1, 1);
              }
            }
          }
          ctx.save();
          ctx.translate(colX + boxWidth / 2, charY + boxHeight / 2);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(offC, -bitmap.rows / 2, -bitmap.width / 2, bitmap.rows, bitmap.width);
          ctx.restore();

        } else if (VERTICAL_SHIFT_CHARS.has(charCode)) {
          // 「。」「、」などは右上に配置
          const dx = colX + boxWidth - bitmap.width;
          const dy = charY;
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                ctx.fillRect(dx + x, dy + y, 1, 1);
              }
            }
          }

        } それ以外 {
          // 通常は文字
          const dx = colX + Math.floor((boxWidth - bitmap.width) / 2);
          const dy = charY + computeBaselineOffset(boxHeight, lineSpacing) - glyph.bitmap_top;
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                ctx.fillRect(dx + x, dy + y, 1, 1);
              }
            }
          }
        }
      }
      charY += boxHeight;
    }
  } それ以外 {
    // 横書きプレビュー
    lineY = 0 とする。
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let charX = 0;
      lineY += boxHeight;
      if (lineY - boxHeight > canvas.height) break;
      for (let i = 0; i < line.length; i++) {
        const charCode = line.charCodeAt(i);
        const char = line[i];
        if (charX + boxWidth > Canvas.width) {
          charX = 0;
          lineY += boxHeight;
          if (lineY - boxHeight > canvas.height) break;
        }
        if (glyphs.has(charCode)) {
          if (shouldRenderBorder) {
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 1;
            ctx.strokeRect(charX + 0.5, lineY - boxHeight + 0.5, boxWidth - 1, boxHeight - 1);
          }
          const glyph = glyphs.get(charCode);
          const bitmap = glyph.bitmap;
          if (bitmap.width > 0 && bitmap.rows > 0 && bitmap.imagedata && !isWhitespaceOrInvisible(charCode)) {
            let dx = charX + Math.floor((boxWidth - bitmap.width) / 2);
            if (useOpticalAlign) {
              dx = charX + getOpticalDx(char, bitmap.width, boxWidth, true);
            }
            // 読点は中央に強制配置
            const isKuten = (charCode === 0x3002 || charCode === 0x3001);
            const dy = isKuten
              ? (lineY - boxHeight) + Math.floor((boxHeight - bitmap.rows) / 2)
              : (lineY - boxHeight) + computeBaselineOffset(boxHeight, lineSpacing) - glyph.bitmap_top;
            if (isKuten) console.log("句読点 dy:", dy, "bitmap.rows:", bitmap.rows, "boxHeight:", boxHeight);
            const sourceData = bitmap.imagedata.data;
            ctx.fillStyle = "#000";
            for (let y = 0; y < bitmap.rows; y++) {
              for (let x = 0; x < bitmap.width; x++) {
                if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                  ctx.fillRect(dx + x, dy + y, 1, 1);
                }
              }
            }
          }
          charX += boxWidth;
        }
      }
    }
  }
}


/**
 * PPIメタデータを設定するためにpHYsチャンクをPNGに追加します
 * pHYsのないPNGはデフォルトで72 DPIとなり、物理サイズが正しくない
 */
function addDpiToPng(dataURL, dpi) {
  試す {
    // データURLをバイナリに変換する
    const base64 = dataURL.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // DPIから1メートルあたりのピクセル数を計算する
    // 1インチ = 0.0254メートルなので、ピクセル/メートル = DPI / 0.0254
    const pixelsPerMeter = Math.round(dpi / 0.0254);

    // pHYsチャンクを作成する
    // フォーマット: [length(4)] [type(4)] [data(9)] [crc(4)]
    const phys = new Uint8Array(4 + 4 + 9 + 4);

    // データの長さ（9バイト）
    phys[0] = 0;
    phys[1] = 0;
    phys[2] = 0;
    phys[3] = 9;

    // チャンクタイプ: "pHYs"
    phys[4] = 112; // p
    phys[5] = 72; // H
    phys[6] = 89; // Y
    phys[7] = 115; // s

    // 単位あたりのピクセル数、X軸（4バイト、ビッグエンディアン）
    phys[8] = (pixelsPerMeter >>> 24) & 0xff;
    phys[9] = (pixelsPerMeter >>> 16) & 0xff;
    phys[10] = (pixelsPerMeter >>> 8) & 0xff;
    phys[11] = pixelsPerMeter & 0xff;

    // 単位あたりのピクセル数、Y軸（4バイト、ビッグエンディアン）
    phys[12] = (pixelsPerMeter >>> 24) & 0xff;
    phys[13] = (pixelsPerMeter >>> 16) & 0xff;
    phys[14] = (pixelsPerMeter >>> 8) & 0xff;
    phys[15] = pixelsPerMeter & 0xff;

    // 単位指定子: 1 = メートル
    phys[16] = 1;

    // チャンクタイプとデータのCRCを計算する
    const crcData = phys.slice(4, 17);
    const crc = calculateCRC(crcData);
    phys[17] = (crc >>> 24) & 0xff;
    phys[18] = (crc >>> 16) & 0xff;
    phys[19] = (crc >>> 8) & 0xff;
    phys[20] = crc & 0xff;

    // pHYを挿入する場所を探す（IHDRチャンクの後）
    // PNG構造：署名(8) + IHDR_length(4) + "IHDR"(4) + IHDR_data(13) + IHDR_crc(4) = 33バイト
    let insertPos = 8 + 4 + 4 + 13 + 4; // 33 バイト - IHDR チャンクの直後

    // pHYsチャンクを使用して新しいPNGを作成します
    const newPng = new Uint8Array(bytes.length + phys.length);
    newPng.set(bytes.slice(0, insertPos), 0);
    newPng.set(phys, insertPos);
    newPng.set(bytes.slice(insertPos), insertPos + phys.length);

    // base64 に戻す
    let binaryString = "";
    for (let i = 0; i < newPng.length; i++) {
      binaryString += String.fromCharCode(newPng[i]);
    }
    return "data:image/png;base64," + btoa(binaryString);
  } catch (error) {
    console.error("PNGにDPIを追加する際のエラー:", error);
    // エラーが発生した場合は元の値を返す
    データURLを返します。
  }
}

/**
 * PNGチャンクのCRC-32計算
 */
function calculateCRC(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 電子書籍リーダーの解像度（480x800ピクセル、220 PPI）でキャンバス上にライブプレビューを表示します。
 * キャンバスは、正しい物理サイズで表示されるように、CSS transform によってスケーリングされます。
 */
function renderRealSizePreview() {
  const canvas = document.getElementById("realSizeCanvas");
  if (!canvas || !activeFont) return;

  const ctx = canvas.getContext("2d");

  const previewText = document.getElementById("previewText").value;
  const fontSize =
    parseInt(document.getElementById("fontSize").value, 10) || 28;
  const charSpacing =
    parseInt(document.getElementById("charSpacing").value, 10) || 0;
  const lineSpacing =
    parseInt(document.getElementById("lineSpacing").value, 10) || 0;
  const threshold =
    parseInt(document.getElementById("lightnessThreshold").value, 10) || 127;
  const shouldRenderBorder = document.getElementById("chkRenderBorder").checked;
  const useOpticalAlign = document.getElementById("chkOpticalAlign").checked;

  // より正確なレンダリングのために、fontSize の代わりに計測された幅を使用します
  const dimensions = measureOptimalFontDimensions(fontSize);
  const boxWidth = dimensions.width + charSpacing;
  const boxHeight = dimensions.height + lineSpacing;

  // 白い背景のクリアキャンバス
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!ft || !activeFont || boxHeight <= 0) return;

  ft.SetFont(activeFont.family_name, activeFont.style_name);
  ft.SetPixelSize(0, fontSize);

  const loadFlags = getFreetypeLoadFlags();
  const isVerticalPreview = document.getElementById("isVerticalFont").checked;
  const baseCodes2 = [...new Set(previewText.split("").map((c) => c.charCodeAt(0)))];
  const extraCodes2 = isVerticalPreview ? [...new Set(VERTICAL_CHAR_MAP.values())] : [];
  const charCodes = [...new Set([...baseCodes2, ...extraCodes2])];
  const glyphs = ft.LoadGlyphs(charCodes, loadFlags);
  // ← 文字コード/グリフが読み込まれました

  const lines = previewText.split(/\r?\n/);

  if (isVerticalPreview) {
    // 縦書きプレビュー: 右から左へ列、上から下へ文字
    const allChars2 = previewText.replace(/\r?\n/g, "").split("");
    let colX = canvas.width - boxWidth;
    let charY = 0;

    for (let i = 0; i < allChars2.length; i++) {
      const char = allChars2[i];
      const charCode = char.charCodeAt(0);

      if (charY + boxHeight > canvas.height) {
        charY = 0;
        colX -= boxWidth;
      }
      (colX < 0) の場合、処理を中断します。

      if (!glyphs.has(charCode)) { charY += boxHeight; continue; }

      if (shouldRenderBorder) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.strokeRect(colX + 0.5, charY + 0.5, boxWidth - 1, boxHeight - 1);
      }

      // 縦書き用グリフに置き換え
      const renderCode3 = (VERTICAL_CHAR_MAP.has(charCode) && glyphs.has(VERTICAL_CHAR_MAP.get(charCode)))
        ? VERTICAL_CHAR_MAP.get(charCode) : charCode;
      if (!glyphs.has(renderCode3)) { charY += boxHeight; continue; }
      const glyph = glyphs.get(renderCode3);
      const bitmap = glyph.bitmap;

      if (bitmap.width > 0 && bitmap.rows > 0 && bitmap.imagedata && !isWhitespaceOrInvisible(charCode)) {
        const sourceData = bitmap.imagedata.data;
        ctx.fillStyle = "#000";

        if (VERTICAL_ROTATE_CHARS.has(charCode) && renderCode3 === charCode) {
          const offC = document.createElement("canvas");
          offC.width = bitmap.width;
          offC.height = bitmap.rows;
          const offCtx = offC.getContext("2d");
          offCtx.fillStyle = "#000";
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                offCtx.fillRect(x, y, 1, 1);
              }
            }
          }
          ctx.save();
          ctx.translate(colX + boxWidth / 2, charY + boxHeight / 2);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(offC, -bitmap.rows / 2, -bitmap.width / 2, bitmap.rows, bitmap.width);
          ctx.restore();

        } else if (VERTICAL_SHIFT_CHARS.has(charCode)) {
          const dx = colX + boxWidth - bitmap.width;
          const dy = charY;
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                ctx.fillRect(dx + x, dy + y, 1, 1);
              }
            }
          }

        } それ以外 {
          const dx = colX + Math.floor((boxWidth - bitmap.width) / 2);
          const dy = charY + computeBaselineOffset(boxHeight, lineSpacing) - glyph.bitmap_top;
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                ctx.fillRect(dx + x, dy + y, 1, 1);
              }
            }
          }
        }
      }
      charY += boxHeight;
    }
  } それ以外 {
    // 横書きプレビュー
    lineY = 0 とする。
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let charX = 0;
      lineY += boxHeight;
      if (lineY - boxHeight > canvas.height) break;
      for (let i = 0; i < line.length; i++) {
        const charCode = line.charCodeAt(i);
        const char = line[i];
        if (charX + boxWidth > Canvas.width) {
          charX = 0;
          lineY += boxHeight;
          if (lineY - boxHeight > canvas.height) break;
        }
        if (glyphs.has(charCode)) {
          if (shouldRenderBorder) {
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 1;
            ctx.strokeRect(charX + 0.5, lineY - boxHeight + 0.5, boxWidth - 1, boxHeight - 1);
          }
          const glyph = glyphs.get(charCode);
          const bitmap = glyph.bitmap;
          if (bitmap.width > 0 && bitmap.rows > 0 && bitmap.imagedata && !isWhitespaceOrInvisible(charCode)) {
            let dx = charX + Math.floor((boxWidth - bitmap.width) / 2);
            if (useOpticalAlign) {
              dx = charX + getOpticalDx(char, bitmap.width, boxWidth, true);
            }
            // 読点は中央に強制配置
            const dy = VERTICAL_SHIFT_CHARS.has(charCode)
              ? (lineY - boxHeight) + Math.floor((boxHeight - bitmap.rows) / 2)
              : (lineY - boxHeight) + computeBaselineOffset(boxHeight, lineSpacing) - glyph.bitmap_top;
            if (charCode === 0x3002) console.log("。 dy:", dy, "bitmap:", bitmap.width, "x", bitmap.rows, "bitmap_top:", glyph.bitmap_top, "boxHeight:", boxHeight, "SHIFT:", VERTICAL_SHIFT_CHARS.has(charCode));
            const sourceData = bitmap.imagedata.data;
            ctx.fillStyle = "#000";
            for (let y = 0; y < bitmap.rows; y++) {
              for (let x = 0; x < bitmap.width; x++) {
                if (shouldRenderPixel(sourceData, (y * bitmap.width + x) * 4, threshold)) {
                  ctx.fillRect(dx + x, dy + y, 1, 1);
                }
              }
            }
          }
          charX += boxWidth;
        }
      }
    }
  }

  // スケール変換を適用します（スライダーで設定されます）
  updateDisplayScale();
}

/**
 * フォントファイルの選択を処理します。
 */
async function handleFontFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  // 前のフォントをアンロードしてWASMメモリを解放
  if (activeFont) {
    試す {
      ft.UnloadFont(activeFont.family_name);
    } catch (e) {
      console.warn("UnloadFont に失敗しました:", e);
    }
    activeFont = null;
  }

  const fontBuffer = await file.arrayBuffer();
  試す {
    const faces = ft.LoadFontFromBytes(new Uint8Array(fontBuffer));
    if (!faces || faces.length === 0) {
      throw new Error("FreeType はフォントファイル内にフェイスを見つけることができませんでした。");
    }
    activeFont = faces[0];

    document.getElementById("fontInfo").innerText =
      `読み込まれたフォント: ${activeFont.family_name}、スタイル: ${activeFont.style_name}`;

    // 最適な幅を測定し、表示に関する推奨事項を提示します
    const currentFontSize =
      parseInt(document.getElementById("fontSize").value, 10) || 28;
    const currentCharSpacing =
      parseInt(document.getElementById("charSpacing").value, 10) || 0;
    const dimensions = measureOptimalFontDimensions(currentFontSize);
    const finalWidth = dimensions.width + currentCharSpacing;
    const finalHeight =
      寸法.高さ +
        parseInt(document.getElementById("lineSpacing").value, 10) || 0;

    // 診断ボックスを作成または更新する
    試す {
      let di = document.getElementById("diagnostics");
      if (!di) {
        di = document.createElement("div");
        di.id = "診断";
        di.style.marginTop = "8px";
        di.style.fontSize = "0.9em";
        di.style.color = "#444";
        di.innerHTML = `<div><strong>診断情報</strong></div>
                    <div>FreeType: <span class="ft">不明</span></div>
                    <div>フォント: <span class="font">未選択</span></div>
                    <div>最適サイズ（測定値）: <span class="measured">不明</span></div>
                    <div>最終サイズ (幅×高さ): <span class="final">不明</span></div>
                    <div>プレビュー文字数: <span class="plen">0</span></div>
                    <div>最終演説: <span class="last">未実行</span></div>`;
        document.getElementById("fontInfo").appendChild(di);
      }
      di.querySelector(".font").textContent =
        `${activeFont.family_name} — ${activeFont.style_name}`;
      di.querySelector(".measured").textContent =
        `${dimensions.width}px × ${dimensions.height}px`;
      di.querySelector(".final").textContent =
        `${finalWidth}px × ${finalHeight}px (${dimensions.width}+${currentCharSpacing} × ${dimensions.height}+${parseInt(document.getElementById("lineSpacing").value, 10) || 0})`;
      const ftEl = di.querySelector(".ft");
      if (ftEl && ft) ftEl.textContent = "読み込み済み";
    } catch (e) {
      console.warn("diag の作成に失敗しました", e);
    }

    updateControlStates();
    renderGlyphToCanvas("A");
    renderPreviewText();
    renderRealSizePreview();
  } catch (err) {
    document.getElementById("fontInfo").innerText =
      "フォントの読み込みに失敗しました。" + (err && err.message ? err.message : err);
    activeFont = null;
    console.error("フォント解析エラー:", err);
  }
}

/**
 読み込んだフォントをバイナリファイルに変換します。
 */
async function convertFontToBin() {
  if (!activeFont) {
    alert("TTFまたはOTFフォントファイルを選択してください。");
    戻る;
  }

  const fontSize =
    parseInt(document.getElementById("fontSize").value, 10) || 28;
  const charSpacing =
    parseInt(document.getElementById("charSpacing").value, 10) || 0;
  const lineSpacing =
    parseInt(document.getElementById("lineSpacing").value, 10) || 0;
  const threshold =
    parseInt(document.getElementById("lightnessThreshold").value, 10) || 127;
  const shouldRenderBorder = document.getElementById("chkRenderBorder").checked;
  const useOpticalAlign = document.getElementById("chkOpticalAlign").checked;

  // 実際の文字レンダリングに基づいて最適な幅を測定する（C# のように）
  const dimensions = measureOptimalFontDimensions(fontSize);
  const width = dimensions.width + charSpacing;
  const height = dimensions.height + lineSpacing;

  if (width <= 0 || height <= 0) {
    alert("幅と高さは1px以上になるように設定してください。");
    戻る;
  }

  const isVerticalFont = document.getElementById("isVerticalFont").checked;

  const totalChar = 0x10000;
  const widthByte = Math.ceil(width / 8);
  const charByte = widthByte * height;
  const binBuffer = new Uint8Array(charByte * totalChar);
  binBuffer.fill(0);

  ft.SetFont(activeFont.family_name, activeFont.style_name);
  ft.SetPixelSize(0, fontSize);

  const progressMsg = document.getElementById("progressMsg");
  progressMsg.textContent = "変換中...";

  // 縦書き時：縦向きグリフを事前に一括ロード
  let verticalGlyphCache = new Map();
  if (isVerticalFont && VERTICAL_CHAR_MAP.size > 0) {
    const vCodes = [...new Set(VERTICAL_CHAR_MAP.values())];
    const vGlyphs = ft.LoadGlyphs(vCodes, getFreetypeLoadFlags());
    verticalGlyphCache = vGlyphs;
  }

  const batchSize = 256;
  for (let i = 0; i < totalChar; i += batchSize) {
    progressMsg.textContent = `変換中... ${i}/${totalChar}`;
    await new Promise((r) => setTimeout(r, 1));

    const loadFlags = getFreetypeLoadFlags();
    const charCodes = Array.from({ length: batchSize }, (_, j) => i + j);
    const glyphs = ft.LoadGlyphs(charCodes, loadFlags);

    for (const [charCode, glyph] of glyphs.entries()) {
      const char = String.fromCharCode(charCode);

      // 縦書き時： 置き換えグリフがあればそこを使用
      let renderGlyph = glyph;
      if (isVerticalFont && VERTICAL_CHAR_MAP.has(charCode)) {
        const vCode = VERTICAL_CHAR_MAP.get(charCode);
        if (verticalGlyphCache.has(vCode) && verticalGlyphCache.get(vCode).bitmap?.width > 0) {
          renderGlyph = verticalGlyphCache.get(vCode);
        }
      }

      const canvas = document.createElement("canvas");
      キャンバスの幅 = 幅;
      キャンバスの高さ = 高さ;
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      if (shouldRenderBorder) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
      }

      if (renderGlyph.bitmap && renderGlyph.bitmap.width > 0 && renderGlyph.bitmap.rows > 0) {
        if (!isWhitespaceOrInvisible(charCode)) {
          // 読点は右上に配置
          const isShift = isVerticalFont && VERTICAL_SHIFT_CHARS.has(charCode);

          dx、dyとする。
          if (isShift) {
            dx = width - renderGlyph.bitmap.width;
            dy = 0;
          } それ以外 {
            dx = Math.floor((width - renderGlyph.bitmap.width) / 2);
            if (useOpticalAlign) dx = getOpticalDx(char, renderGlyph.bitmap.width, width, true);
            const baseline = computeBaselineOffset(height, lineSpacing);
            dy = baseline - renderGlyph.bitmap_top;
          }

          const sourceData = renderGlyph.bitmap.imagedata.data;
          ctx.fillStyle = "#000";

          if (false) { // 回転方式は廃止
            // 使用しない
          } それ以外 {
            for (let y = 0; y < glyph.bitmap.rows; y++) {
              for (let x = 0; x < glyph.bitmap.width; x++) {
                if (shouldRenderPixel(sourceData, (y * glyph.bitmap.width + x) * 4, threshold)) {
                  ctx.fillRect(dx + x, dy + y, 1, 1);
                }
              }
            }
          }
        }
      }

      const finalImageData = ctx.getImageData(0, 0, width, height).data;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pixelIndex = (y * width + x) * 4;
          const ビット = FinalImageData[pixelIndex] < 128 ? 1:0;

          if (bit) {
            let finalByteIdx, finalBitIdx;
            if (isVerticalFont) {
              // 縦書き: 90度回転。x軸反転してミラーを修正
              const rx = width - 1 - x;
              finalByteIdx = charCode * charByte + rx * widthByte + (y >> 3);
              finalBitIdx = 7 - (y % 8);
            } それ以外 {
              finalByteIdx = charCode * charByte + y * widthByte + (x >> 3);
              finalBitIdx = 7 - (x % 8);
            }
            if (finalByteIdx < binBuffer.length) {
              binBuffer[finalByteIdx] |= 1 << finalBitIdx;
            }
          }
        }
      }
    }
  }

  progressMsg.textContent = "ダウンロード準備完了！";
  const blob = new Blob([binBuffer], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `font_${width}x${height}.bin`;
  a.click();
  URL.revokeObjectURL(a.href);
  setTimeout(() => {
    progressMsg.textContent = "";
  }, 3000);
  return { blob, width, height };
}

// blobをbase64に読み込む（データなし：プレフィックス）
function readBlobAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      const comma = res.indexOf(",");
      resolve(res.slice(comma + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function slugify(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/\p{発音記号}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ブラウザでUTF-8文字列を適切にbase64エンコードする
function base64EncodeUnicode(str) {
  // encodeURIComponent -> パーセントエンコーディング -> 生のバイトに変換
  btoaを返す(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (match, p1) {
      return String.fromCharCode("0x" + p1);
    }),
  );
}

async function saveToServer() {
  const status = document.getElementById("saveServerStatus");
  if (!status) return;
  status.textContent = ".binファイルを生成中...";
  const res = await convertFontToBin();
  if (!res) {
    status.textContent = "変換に失敗しました。";
    戻る;
  }
  const { blob, width, height } = res;

  status.textContent = "電子書籍リーダーの画面プレビューを準備しています...";
  const previewCanvas = document.getElementById("realSizeCanvas");
  const previewBlob = await new Promise((r) =>
    previewCanvas.toBlob(r, "image/png"),
  );

  // ギャラリー一覧表示用の小さなサムネイルを作成します（最大サイズ360ピクセル）
  function createThumbnail(canvas, maxDim = 360) {
    const w = canvas.width;
    const h = canvas.height;
    const ratio = Math.max(1, Math.max(w, h) / maxDim);
    const tw = Math.max(1, Math.round(w / ratio));
    const th = Math.max(1, Math.round(h / ratio));
    const tmp = document.createElement("canvas");
    tmp.width = tw;
    tmp.height = th;
    const tctx = tmp.getContext("2d");
    // 白い背景
    tctx.fillStyle = "#fff";
    tctx.fillRect(0, 0, tw, th);
    tctx.drawImage(canvas, 0, 0, w, h, 0, 0, tw, th);

    // 診断プレビューの長さと最後のレンダリングを更新します
    試す {
      const di = document.getElementById("diagnostics");
      if (di) {
        di.querySelector(".plen").textContent = previewText.length;
        di.querySelector(".last").textContent = new Date().toLocaleTimeString();
      }
    } catch (e) {
      /* 無視する */
    }
    tmpを返す;
  }

  const thumbCanvas = createThumbnail(previewCanvas, 360);
  const thumbBlob = await new Promise((r) =>
    thumbCanvas.toBlob(r, "image/png"),
  );

  status.textContent = "電子書籍リーダーのプレビューをエンコードしています...";
  const binBase64 = await readBlobAsBase64(blob);
  const previewBase64 = await readBlobAsBase64(previewBlob);
  const thumbBase64 = await readBlobAsBase64(thumbBlob);

  // アップロード前のチェック: bin ファイルがサーバーのデフォルトサイズを超えている場合はユーザーに通知します
  const binBytes = blob.size || Math.floor((binBase64.length * 3) / 4);
  const SERVER_MAX_BIN = 12 * 1024 * 1024; // クライアント側の期待値 12B (サーバーのデフォルト値と一致)
  if (binBytes > SERVER_MAX_BIN) {
    const mb = (binBytes / (1024 * 1024)).toFixed(2);
    アラート(
      生成された.binファイルは${mb} MBで、設定されたサーバー制限（~${SERVER_MAX_BIN / (1024 * 1024)} MB）を超えています。フォントサイズ/間隔を小さくするか、別の設定を有効にしてください。または、サーバーのMAX_BIN_BYTESを増やしてください。
    );
    status.textContent = "エラー: .bin ファイルが大きすぎてサーバーに届きません";
    戻る;
  }

  const family = activeFont ? activeFont.family_name : "Unknown";
  const style = activeFont ? activeFont.style_name : "Unknown";
  const previewText = document.getElementById("previewText").value;
  const submitter =
    (document.getElementById("submitterName")?.value || "").trim() || "Anonymous";

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = slugify(`${family}-${style}-${timestamp}`);
  const folder = `gallery/${slug}`;

  const metadata = {
    id: スラッグ、
    家族、
    スタイル、
    preview_text: previewText、
    幅、
    身長、
    タイムスタンプ: 新しい Date().toISOString()、
    提出者: { 名前: 提出者 }、
  };

  const files = {};
  files[`${folder}/metadata.json`] = base64EncodeUnicode(
    JSON.stringify(metadata, null, 2),
  );
  files[`${folder}/preview.png`] = previewBase64;
  files[`${folder}/preview_thumb.png`] = thumbBase64;
  files[`${folder}/font_${width}x${height}.bin`] = binBase64;

  status.textContent = "サーバーにアップロード中...";
  試す {
    // リクエストが永久にハングアップしないように、AbortController を準備します
    const controller = new AbortController();
    const timeoutMs = 30000; // 30秒
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // デバッグ: ペイロードのおおよそのサイズをログに記録する
    試す {
      const metaSize = files[`${folder}/metadata.json`].length;
      const previewSize = files[`${folder}/preview.png`].length;
      const binSize = files[`${folder}/font_${width}x${height}.bin`].length;
      console.log("アップロードペイロードサイズ（base64文字）：", {
        メタサイズ、
        プレビューサイズ、
        binSize、
      });
    } catch (e) {
      console.warn("ペイロードサイズの計算に失敗しました", e);
    }

    // リポジトリを自動的にターゲットする（プロンプトなし）
    const repoFull = "lakafior/XTEink-Web-Font-Maker";
    const [所有者、リポジトリ] = repoFull.split("/");
    const resp = await fetch(`${API_BASE}/submit`, {
      メソッド: "POST",
      ヘッダー: { "Content-Type": "application/json" },
      body: JSON.stringify({
        所有者、
        リポジトリ、
        ナメクジ、
        ファイル、
        家族、
        スタイル、
        preview_text: previewText、
      }),
      シグナル: コントローラーシグナル、
    });
    clearTimeout(timeoutId);
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || JSON.stringify(j));
    status.textContent = "";
    alert("PRが作成されました: " + j.pr);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("アップロードが30秒後にタイムアウトしました");
      ステータス.textContent =
        「エラー：アップロードがタイムアウトしました（サーバーからの応答がありません）。トンネル/サーバーを確認してください。」
      戻る;
    }
    console.error(err);
    status.textContent = "エラー: " + (err && err.message ? err.message : err);
  }
}

書類
  .getElementById("saveServerBtn")
  ?.addEventListener("click", saveToServer);

function updateControlStates() {
  const isAntiAlias = document.getElementById("chkRenderAntiAlias").checked;
  document.getElementById("lightnessThreshold").disabled = !isAntiAlias;
  document.getElementById("lightnessThresholdValue").style.opacity = isAntiAlias
    ？1
    : 0.5;
}

/**
 * フォントサイズが変更されると、診断画面の測定幅表示を更新します。
 */
function updateMeasuredWidth() {
  if (!activeFont) return;

  const currentFontSize =
    parseInt(document.getElementById("fontSize").value, 10) || 28;
  const currentCharSpacing =
    parseInt(document.getElementById("charSpacing").value, 10) || 0;
  const dimensions = measureOptimalFontDimensions(currentFontSize);
  const finalWidth = dimensions.width + currentCharSpacing;
  const finalHeight =
    寸法.高さ +
    (parseInt(document.getElementById("lineSpacing").value, 10) || 0);

  試す {
    const di = document.getElementById("diagnostics");
    if (di) {
      const measuredEl = di.querySelector(".measured");
      const FinalEl = di.querySelector(".final");

      if (measuredEl) {
        measuredEl.textContent = `${dimensions.width}px × ${dimensions.height}px`;
      }
      if (finalEl) {
        finalEl.textContent = `${finalWidth}px × ${finalHeight}px (${dimensions.width}+${currentCharSpacing} × ${dimensions.height}+${parseInt(document.getElementById("lineSpacing").value, 10) || 0})`;
      }
    }
  } catch (e) {
    console.warn("計測された幅の更新に失敗しました", e);
  }
}

// --- イベントリスナー ---
書類
  .getElementById("fontFile")
  .addEventListener("change", handleFontFileChange);
書類
  .getElementById("convertBtn")
  .addEventListener("click", convertFontToBin);

const inputs = [
  「文字間隔」
  「行間隔」
  「フォントサイズ」
  「isVerticalFont」
  「軽さの閾値」
  「chkRenderAntiAlias」
  「chkRenderGridFit」
  「chkRenderBorder」
  「chkOpticalAlign」
];
const previewEl = document.getElementById("previewText");
const previewCount = document.getElementById("previewCount");
const PREVIEW_MAX = 500;

function updatePreviewCount() {
  const remaining =
    PREVIEW_MAX - (previewEl.value ? previewEl.value.length : 0);
  reviewCount.textContent = `残り${残り}文字`;
}

// 最大長を超えるペーストを防止する
previewEl.addEventListener("paste", (e) => {
  const paste = (e.clipboardData || window.clipboardData).getData("text");
  const willBe = (previewEl.value || "") + paste;
  if (willBe.length > PREVIEW_MAX) {
    e.preventDefault();
    // 残りのペーストを切り取る
    const allowed =
      PREVIEW_MAX - (previewEl.value ? previewEl.value.length : 0);
    if (allowed > 0) {
      const trimmed = paste.slice(0, allowed);
      const start = previewEl.selectionStart || previewEl.value.length;
      const before = previewEl.value.slice(0, start);
      const after = previewEl.value.slice(previewEl.selectionEnd || start);
      previewEl.value = before + trimmed + after;
      // カーソルを移動
      const pos = start + trimmed.length;
      previewEl.setSelectionRange(pos, pos);
      updatePreviewCount();
      renderPreviewText();
    }
  }
});

previewEl.addEventListener("input", () => {
  updatePreviewCount();
});
inputs.forEach((id) => {
  const element = document.getElementById(id);
  if (要素) {
    // チェックボックスはchangeイベント、それ以外はinputイベント
    const eventType = element.type === "checkbox" ? "change" : "input";
    element.addEventListener(eventType, () => {
      updateControlStates();
      renderPreviewText();
      renderRealSizePreview();
      renderGlyphToCanvas("A");

      if (id === "fontSize" || id === "charSpacing") {
        updateMeasuredWidth();
      }
    });
  }
});

// また、previewText をレンダリングとコントロールに接続します。
if (previewEl) {
  previewEl.addEventListener("input", () => {
    updateControlStates();
    renderPreviewText();
    renderRealSizePreview();
    renderGlyphToCanvas("A");
  });
  // カウンタを初期化する
  updatePreviewCount();
}

document.getElementById("lightnessThreshold").addEventListener("input", (e) => {
  document.getElementById("lightnessThresholdValue").textContent =
    e.ターゲット値;
});

// ウィンドウサイズ変更時にテキストプレビューのサイズを変更します
window.addEventListener("resize", () => {
  renderPreviewText();
  renderRealSizePreview();
});

// プレビューをPNG形式でエクスポートするボタン
document.getElementById("exportPreviewBtn")?.addEventListener("click", () => {
  const canvas = document.getElementById("realSizeCanvas");
  if (!canvas) return;

  const dataURL = canvas.toDataURL("image/png");
  const fontSize = document.getElementById("fontSize").value || "28";
  const fontName = activeFont
    ? `${activeFont.family_name}-${activeFont.style_name}`
    : "フォント";
  const filename = `${slugify(fontName)}-${fontSize}px-preview-480x800.png`;

  const a = document.createElement("a");
  a.href = dataURL;
  a.download = ファイル名;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  const statusEl = document.getElementById("calibrationStatus");
  if (statusEl) {
    constoriginalText = statusEl.textContent;
    statusEl.textContent = `✓ エクスポート済み: ${filename}`;
    statusEl.style.color = "#4caf50";
    statusEl.style.fontWeight = "bold";

    setTimeout(() => {
      statusEl.textContent = オリジナルテキスト;
      statusEl.style.color = "#888";
      statusEl.style.fontWeight = "normal";
    }, 3000);
  }
});

// モニターのDPIを自動検出してスケールを提案します
function autoDetectScale() {
  if (!displayScaleSlider) return;

  // ユーザーが以前にディスプレイをキャリブレーションしたことがあるかどうかを確認する
  const savedScale = localStorage.getItem("ereaderPreviewScale");

  if (savedScale) {
    // 保存済みのキャリブレーションを使用する
    const scale = parseInt(savedScale, 10);
    displayScaleSlider.value = scale.toString();

    const statusEl = document.getElementById("calibrationStatus");
    if (statusEl) {
      statusEl.innerHTML = `✓ <strong>保存済みキャリブレーション: ${scale}%</strong> - 必要に応じてスライダーで調整してください`;
      statusEl.style.color = "#4caf50";
    }
    戻る;
  }

  // 実際の画面DPIを検出します
  const dpr = window.devicePixelRatio || 1;

  提案スケールを100とします。

  if (dpr >= 2) {
    // Retina/HiDPIディスプレイ - より大きなスケールを推奨
    suggestedScale = Math.round(100 * 1.4); // 140%
  } else if (dpr > 1 && dpr < 2) {
    suggestedScale = Math.round(100 * (1 + (dpr - 1) * 0.8)); // 補間
  }

  displayScaleSlider.value = suggestedScale.toString();

  const statusEl = document.getElementById("calibrationStatus");
  if (statusEl && suggestedScale !== 100) {
    statusEl.innerHTML = `💡スケールを${suggestedScale}%に自動設定しました - 定規で実際のサイズを確認しながら調整して保存してください`;
    statusEl.style.color = "#ff9800";
  }
}

// 実寸大プレビューを表示するスケールスライダー
const displayScaleSlider = document.getElementById("displayScale");
const displayScaleValue = document.getElementById("displayScaleValue");
const realSizeCanvas = document.getElementById("realSizeCanvas");

function updateDisplayScale() {
  if (!displayScaleSlider || !realSizeCanvas) return;

  const scale = parseInt(displayScaleSlider.value, 10) / 100;

  //スケールはCSS(width:100%)で制御するためJSでは変更不要
  realSizeCanvas.style.transform = "";

  if (displayScaleValue) {
    displayScaleValue.textContent = (scale * 100).toFixed(0) + "%";
  }

  // 情報テキストを更新する
  const infoEl = document.getElementById("previewDimensionsInfo");
  if (infoEl) {
    const actualWidth = Math.round(55 * scale * 10) / 10;
    const actualHeight = Math.round(93 * scale * 10) / 10;
    infoEl.textContent = `現在の表示サイズ: ${actualWidth}mm × ${actualHeight}mm（55mm × 93mmに合わせてください）`;
  }
}

displayScaleSlider?.addEventListener("input", updateDisplayScale);

// キャリブレーション保存ボタン
document.getElementById("saveCalibration")?.addEventListener("click", () => {
  if (!displayScaleSlider) return;

  const scalePercent = parseInt(displayScaleSlider.value, 10);
  localStorage.setItem("ereaderPreviewScale", scalePercent.toString());

  const statusEl = document.getElementById("calibrationStatus");
  if (statusEl) {
    statusEl.innerHTML = `<strong>✓ キャリブレーションが保存されました！(${scalePercent}%)</strong> 次回はこのスケールが自動的に使用されます。`;
    statusEl.style.color = "#4caf50";
    statusEl.style.fontWeight = "bold";

    // 5秒後にスタイルをリセット
    setTimeout(() => {
      if (statusEl) {
        statusEl.innerHTML = `✓ <strong> キャリブレーションを保存しました: ${scalePercent}%</strong>`;
        statusEl.style.fontWeight = "normal";
      }
    }, 5000);
  }
});

// リセットボタン - 保存されたキャリブレーションをクリアし、自動検出を使用します
document.getElementById("resetDisplayScale")?.addEventListener("click", () => {
  if (displayScaleSlider) {
    // 保存済みのキャリブレーションをクリアする
    localStorage.removeItem("ereaderPreviewScale");

    // 自動検出を再実行する
    autoDetectScale();
    updateDisplayScale();

    const statusEl = document.getElementById("calibrationStatus");
    if (statusEl) {
      statusEl.innerHTML =
        "💡キャリブレーションをリセットしました。自動検出を適用中 - 定規で確認しながらスライダーを調整して保存してください";
      statusEl.style.color = "#ff9800";
    }
  }
});

// ロード時に初期状態を設定する
updateControlStates();

// 自動検出で実寸大プレビューを初期化します
autoDetectScale();
updateDisplayScale();

// --- 開発者ヘルパー: bin グリフがプレビューと一致するかどうかを確認します ---
// 使用方法（コンソール）：verifyBinMatchesPreview(['A','a','0']);
window.verifyBinMatchesPreview = async function (
  文字 = ["A", "a", "0"]、
  show = false、
) {
  if (!activeFont) {
    console.warn("フォントが読み込まれていません。まずフォントを読み込んでください。");
    戻る;
  }
  const fontSize =
    parseInt(document.getElementById("fontSize").value, 10) || 28;
  const charSpacing =
    parseInt(document.getElementById("charSpacing").value, 10) || 0;
  const lineSpacing =
    parseInt(document.getElementById("lineSpacing").value, 10) || 0;
  const threshold =
    parseInt(document.getElementById("lightnessThreshold").value, 10) || 127;
  const shouldRenderBorder = document.getElementById("chkRenderBorder").checked;
  const useOpticalAlign = document.getElementById("chkOpticalAlign").checked;
  const isVerticalFont = document.getElementById("isVerticalFont").checked;

  const width = fontSize + charSpacing;
  const height = fontSize + lineSpacing;

  function renderGlyphOffscreen(char) {
    const canvas = document.createElement("canvas");
    キャンバスの幅 = 幅;
    キャンバスの高さ = 高さ;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (shouldRenderBorder) {
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    }
    if (ft && activeFont) {
      ft.SetFont(activeFont.family_name, activeFont.style_name);
      ft.SetPixelSize(0, fontSize);
      const loadFlags = getFreetypeLoadFlags();
      const glyphs = ft.LoadGlyphs([char.charCodeAt(0)], loadFlags);
      const glyph = glyphs.get(char.charCodeAt(0));
      もし （
        グリフ&&
        グリフ.ビットマップ &&
        glyph.bitmap.width > 0 &&
        glyph.bitmap.rows > 0 &&
        グリフ.ビットマップ.画像データ
      ) {
        const bitmap = glyph.bitmap;

        let dx = Math.floor((width - bitmap.width) / 2);

        if (useOpticalAlign) dx = getOpticalDx(char, bitmap.width, width, true);

        const baseline = computeBaselineOffset(height, lineSpacing);
        const dy = baseline - glyph.bitmap_top;

        const sourceData = bitmap.imagedata.data;
        ctx.fillStyle = "#000";
        for (let y = 0; y < bitmap.rows; y++) {
          for (let x = 0; x < bitmap.width; x++) {
            const i = (y * bitmap.width + x) * 4;
            if (shouldRenderPixel(sourceData, i, threshold))
              ctx.fillRect(dx + x, dy + y, 1, 1);
          }
        }
      }
    }
    キャンバスを返す。
  }

  function packCanvasToBinBytes(canvas) {
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const widthByte = Math.ceil(canvas.width / 8);
    const charByte = widthByte * canvas.height;
    const arr = new Uint8Array(charByte);
    arr.fill(0);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4;
        const bit = data[idx] < 128 ? 1 : 0;
        if (bit) {
          const byteIdx = y * widthByte + (x >> 3);
          const bitIdx = 7 - (x % 8);
          arr[byteIdx] |= 1 << bitIdx;
        }
      }
    }
    return { bytes: arr, widthByte, charByte };
  }

  function unpackBinBytesToCanvas(bytes, width, height) {
    const canvas = document.createElement("canvas");
    キャンバスの幅 = 幅;
    キャンバスの高さ = 高さ;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    const img = ctx.getImageData(0, 0, width, height);
    const widthByte = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byteIdx = y * widthByte + (x >> 3);
        const bitIdx = 7 - (x % 8);
        const bit = (bytes[byteIdx] >> bitIdx) & 1;
        if (bit) {
          const i = (y * width + x) * 4;
          img.data[i] = 0;
          img.data[i + 1] = 0;
          img.data[i + 2] = 0;
          img.data[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    キャンバスを返す。
  }

  for (const ch of chars) {
    const orig = renderGlyphOffscreen(ch);
    const packed = packCanvasToBinBytes(orig);
    const unpacked = unpackBinBytesToCanvas(packed.bytes, width, height);

    // ピクセル単位で比較
    const a = orig.getContext("2d").getImageData(0, 0, width, height).data;
    const b = unpacked.getContext("2d").getImageData(0, 0, width, height).data;
    不一致を0とする。
    for (let i = 0; i < a.length; i += 4) {
      const aa = a[i] < 128 ? 1 : 0;
      const bb = b[i] < 128 ? 1 : 0;
      (aa !== bb) 不一致++;
    }
    if (不一致 === 0)
      console.log(`OK: '${ch}' は (${width}x${height}) と完全に一致します`);
    それ以外
      console.warn(
        `不一致: '${ch}' には ${mismatch} 個の異なるピクセルがあります (${width}x${height})`,
      );
    // コンソールで手動で検査できるようにキャンバスを公開する
    console.log("元のキャンバス:", orig);
    console.log("展開されたキャンバス:", unpacked);

    if (show) {
      試す {
        let container = document.getElementById("verify-compare");
        if (!container) {
          container = document.createElement("div");
          container.id = "verify-compare";
          container.style.position = "fixed";
          container.style.right = "12px";
          container.style.top = "12px";
          container.style.zIndex = 9999;
          container.style.maxHeight = "90vh";
          container.style.overflow = "auto";
          container.style.background = "rgba(255,255,255,0.95)";
          container.style.border = "1px solid #ddd";
          container.style.padding = "8px";
          container.style.boxShadow = "0 6px 24px rgba(0,0,0,0.15)";
          container.style.fontSize = "13px";
          const closeBtn = document.createElement("button");
          closeBtn.textContent = "✕";
          closeBtn.style.float = "right";
          closeBtn.style.marginLeft = "8px";
          closeBtn.addEventListener("click", () => container.remove());
          container.appendChild(closeBtn);
          const title = document.createElement("div");
          title.textContent = "verifyBinMatchesPreview の結果";
          title.style.fontWeight = "700";
          title.style.marginBottom = "6px";
          container.appendChild(title);
          document.body.appendChild(container);
        }

        const block = document.createElement("div");
        block.style.display = "flex";
        block.style.gap = "8px";
        block.style.alignItems = "center";
        block.style.marginBottom = "8px";

        const label = document.createElement("div");
        label.textContent = `${ch} — ${mismatch === 0 ? "OK" : "MISMATCH: " + mismatch}`;
        label.style.minWidth = "140px";
        block.appendChild(label);

        const wrapOrig = document.createElement("div");
        const l1 = document.createElement("div");
        l1.textContent = "オリジナル";
        l1.style.fontSize = "11px";
        l1.style.textAlign = "center";
        wrapOrig.appendChild(l1);
        wrapOrig.appendChild(orig);
        const a1 = document.createElement("a");
        a1.textContent = "ダウンロード";
        a1.href = orig.toDataURL("image/png");
        a1.download = `${ch}-orig.png`;
        wrapOrig.appendChild(a1);
        block.appendChild(wrapOrig);

        const wrapUn = document.createElement("div");
        const l2 = document.createElement("div");
        l2.textContent = "unpacked";
        l2.style.fontSize = "11px";
        l2.style.textAlign = "center";
        wrapUn.appendChild(l2);
        wrapUn.appendChild(unpacked);
        const a2 = document.createElement("a");
        a2.textContent = "ダウンロード";
        a2.href = unpacked.toDataURL("image/png");
        a2.download = `${ch}-unpacked.png`;
        wrapUn.appendChild(a2);
        block.appendChild(wrapUn);

        container.appendChild(block);
      } catch (e) {
        console.warn("比較UIのレンダリングに失敗しました", e);
      }
    }
  }
};
// また、window がグローバルではないコンソール環境向けに globalThis を公開します。
試す {
  globalThis.verifyBinMatchesPreview = window.verifyBinMatchesPreview;
} catch (e) {
  /* 無視する */
}
