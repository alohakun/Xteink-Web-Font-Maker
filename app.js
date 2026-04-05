import FreeTypeInit from "https://cdn.jsdelivr.net/npm/freetype-wasm@0/dist/freetype.js";

// Global state
let ft = null; // FreeType library instance
let activeFont = null; // The currently active font face

// --- FreeType Initialization ---
try {
  ft = await FreeTypeInit();
  // update diagnostics if present
  try {
    const di = document.getElementById("diagnostics");
    if (di) di.querySelector(".ft").textContent = "読み込み済み";
  } catch (e) {}
} catch (err) {
  console.error("Failed to initialize FreeType:", err);
  alert(
    "Critical error: Could not load FreeType library. Check the browser console.",
  );
  throw new Error("FreeType failed to initialize");
}

// --- Helper Functions ---

// API base URL for server submissions. Set this to your Cloudflare Tunnel hostname.
const API_BASE = "https://apixtgallery.lakafior.com";

/**
 * Helper function to check if a character is a whitespace/invisible character.
 * These characters should render as blank even if FreeType returns a .notdef glyph.
 */
// 縦書き時の文字置換マップ（横向き文字→縦向きグリフ）
const VERTICAL_CHAR_MAP = new Map([
  [0x30FC, 0xFE31],  // ー → ︱
  [0x2015, 0xFE31],  // ― → ︱
  [0xFF0D, 0xFE31],  // － → ︱
  [0x007E, 0xFE34],  // ~ → ︴
  [0xFF5E, 0xFE34],  // ～ → ︴
  [0x2026, 0xFE19],  // … → ︙
  [0x2025, 0xFE19],  // ‥ → ︙
  [0x3001, 0xFE11],  // 、→ ︑
  [0x3002, 0xFE12],  // 。→ ︒
  [0xFF08, 0xFE35],  // （→ ︵
  [0xFF09, 0xFE36],  // ）→ ︶
  [0x300C, 0xFE41],  // 「→ ﹁
  [0x300D, 0xFE42],  // 」→ ﹂
  [0x300E, 0xFE43],  // 『→ ﹃
  [0x300F, 0xFE44],  // 』→ ﹄
  [0x3010, 0xFE39],  // 【→ ︹
  [0x3011, 0xFE3A],  // 】→ ︺
  [0xFF3B, 0xFE47],  // ［→ ﹇
  [0xFF3D, 0xFE48],  // ］→ ﹈
]);

function getVerticalCharCode(charCode) {
  return VERTICAL_CHAR_MAP.get(charCode) ?? charCode;
}

function isWhitespaceOrInvisible(charCode) {
  // Common whitespace and invisible characters that should render as blank
  const whitespaceChars = new Set([
    0x0020, // SPACE
    0x00a0, // NO-BREAK SPACE
    0x1680, // OGHAM SPACE MARK
    0x2000,
    0x2001,
    0x2002,
    0x2003,
    0x2004,
    0x2005, // EN QUAD, EM QUAD, EN SPACE, EM SPACE, THREE-PER-EM SPACE, FOUR-PER-EM SPACE
    0x2006,
    0x2007,
    0x2008,
    0x2009,
    0x200a, // SIX-PER-EM SPACE, FIGURE SPACE, PUNCTUATION SPACE, THIN SPACE, HAIR SPACE
    0x202f, // NARROW NO-BREAK SPACE
    0x205f, // MEDIUM MATHEMATICAL SPACE
    0x3000, // IDEOGRAPHIC SPACE (CJK full-width space) - very common in Chinese text!
    0x0009, // TAB
    0x000a, // LINE FEED
    0x000b, // VERTICAL TAB
    0x000c, // FORM FEED
    0x000d, // CARRIAGE RETURN
    0x0085, // NEXT LINE
    0x00ad, // SOFT HYPHEN
    0x200b, // ZERO WIDTH SPACE
    0x200c, // ZERO WIDTH NON-JOINER
    0x200d, // ZERO WIDTH JOINER
    0x2060, // WORD JOINER
    0xfeff, // ZERO WIDTH NO-BREAK SPACE
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
    flags |= ft.FT_LOAD_TARGET_NORMAL; // Grayscale anti-aliasing
  } else {
    flags |= ft.FT_LOAD_TARGET_MONO; // 1-bit monochrome rendering
  }

  return flags;
}

/**
 * Determines if a pixel from the FreeType bitmap should be rendered as black.
 * Checks both RGB luminance and alpha channel for better Cyrillic and complex glyph support.
 * @param {Uint8ClampedArray} data - The RGBA pixel data
 * @param {number} index - The starting index of the pixel (R channel)
 * @param {number} threshold - The threshold value (0-255)
 * @returns {boolean} - True if pixel should be rendered black
 */
function shouldRenderPixel(data, index, threshold) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];

  // For FreeType bitmaps, the alpha channel typically contains the coverage/intensity
  // However, for some fonts (especially Cyrillic), we need to also check RGB values
  //
  // Strategy:
  // 1. Primary check: alpha channel (most fonts put glyph data here)
  // 2. Fallback check: if alpha is moderate, also check if RGB is dark
  //    This helps with fonts where glyph data is in RGB channels

  // Check alpha first (standard FreeType antialiased glyphs)
  if (a > threshold) {
    return true;
  }

  // Calculate luminance for RGB check (perceived brightness)
  // Using standard luminance formula: 0.299*R + 0.587*G + 0.114*B
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

  // Fallback: if pixel has some alpha and is dark, render it
  // This catches Cyrillic and other glyphs where data is in RGB
  // Use a lower alpha threshold (threshold/4) to be more permissive
  if (a > threshold / 4 && luminance < 255 - threshold) {
    return true;
  }

  return false;
}

/**
 * Measures optimal font dimensions using representative characters.
 * Uses 'M' for width (typically widest Latin character) and 'Å' for height (tall with accent).
 * @param {number} fontSize - The font size in pixels
 * @returns {{width: number, height: number}} - The measured dimensions in pixels
 */
function measureOptimalFontDimensions(fontSize) {
  if (!ft || !activeFont) {
    return { width: fontSize, height: fontSize };
  }

  try {
    ft.SetFont(activeFont.family_name, activeFont.style_name);
    ft.SetPixelSize(0, fontSize);

    // Scan representative wide and tall characters
    // Wide: W, M, @, %, #, m, w
    // Tall: Å, Ä, Ö, É, Ë, d, b, h, l
    const testChars = [
      0x0057,
      0x004d,
      0x0040,
      0x0025,
      0x0023,
      0x006d,
      0x0077, // W M @ % # m w
      0x00c5,
      0x00c4,
      0x00d6,
      0x00c9,
      0x00cb, // Å Ä Ö É Ë
      0x0064,
      0x0062,
      0x0068,
      0x006c, // d b h l
    ];

    const loadFlags = ft.FT_LOAD_RENDER | ft.FT_LOAD_TARGET_MONO;
    const glyphs = ft.LoadGlyphs(testChars, loadFlags);

    let maxWidth = 0;
    let maxHeight = 0;
    let widestChar = "";
    let tallestChar = "";

    // Scan all glyphs and find MAX bitmap.width and MAX bitmap.rows
    for (const [charCode, glyph] of glyphs.entries()) {
      const char = String.fromCharCode(charCode);

      // Check bitmap.width (actual rendered pixels)
      if (glyph.bitmap && glyph.bitmap.width > 0) {
        if (glyph.bitmap.width > maxWidth) {
          maxWidth = glyph.bitmap.width;
          widestChar = char;
        }
      }

      // Check bitmap.rows (actual rendered height)
      if (glyph.bitmap && glyph.bitmap.rows > 0) {
        if (glyph.bitmap.rows > maxHeight) {
          maxHeight = glyph.bitmap.rows;
          tallestChar = char;
        }
      }
    }

    let measuredWidth = maxWidth;
    let measuredHeight = maxHeight;
    let widthChar = widestChar;
    let heightChar = tallestChar;

    // Apply C# minimum of 5 pixels and fallback to fontSize if needed
    measuredWidth = Math.max(5, measuredWidth || fontSize);
    measuredHeight = Math.max(5, measuredHeight || fontSize);

    console.log(
      `📏 Measured font dimensions at fontSize=${fontSize}px (scanned ${testChars.length} chars):`,
      {
        width: measuredWidth,
        height: measuredHeight,
        widestChar: widthChar || "fallback",
        tallestChar: heightChar || "fallback",
        scannedGlyphs: glyphs.size,
      },
    );

    return { width: measuredWidth, height: measuredHeight };
  } catch (e) {
    console.warn("Failed to measure optimal font dimensions:", e);

    return { width: fontSize, height: fontSize };
  }
}

function computeBaselineOffset(boxHeight, lineSpacing) {
  if (boxHeight <= 0) return 0;

  const contentHeight = Math.max(0, boxHeight - lineSpacing);
  const baseBaseline = Math.round(contentHeight * 0.75);
  const spacingOffset = Math.floor(lineSpacing / 2);
  let baseline = baseBaseline + spacingOffset;

  if (baseline < 0) return 0;
  if (baseline > boxHeight) return boxHeight;
  return baseline;
}

const optical_offsets = {
  // ============================================
  // OKRĄGŁE ZNAKI - silne przesunięcie w lewo
  // ============================================
  // Okrągłe litery mają "optyczną masę" w środku, więc geometryczne
  // wycentrowanie sprawia, że wydają się za daleko. Przesuwamy je w lewo.
  O: -0.1,
  Q: -0.1,
  C: -0.09,
  G: -0.09,
  o: -0.1,
  q: -0.1,
  c: -0.09,
  g: -0.09,
  0: -0.1,
  6: -0.08,
  8: -0.08,
  9: -0.08,

  // Półokrągłe - średnie przesunięcie w lewo
  D: -0.06,
  d: -0.06,
  S: -0.05,
  s: -0.05,
  3: -0.06,
  5: -0.05,
  2: -0.04,

  // ============================================
  // ZNAKI Z "DACHEM" - przesunięcie w prawo
  // ============================================
  // Litery z szerokim górem i wąskim dołem tworzą przestrzeń optyczną
  // pod sobą. Przesunięcie w prawo pozwala następnej literze wypełnić tę lukę.
  T: 0.07,
  Y: 0.06,
  V: 0.06,
  W: 0.05,
  A: 0.04,
  y: 0.05,
  v: 0.05,
  w: 0.04,
  7: 0.06,

  // ============================================
  // WĄSKIE ZNAKI - neutralne lub minimalne
  // ============================================
  // Wąskie znaki wyglądają najlepiej gdy są wycentrowane.
  // Problem z "ill" nie jest do rozwiązania przez offset - to kwestia
  // szerokości boxa, której nie możemy zmienić.
  I: 0,
  l: 0,
  i: 0,
  1: 0,
  "!": 0,
  "|": 0,
  t: 0,
  f: 0,
  j: 0,
  r: 0, // 'r' jest wąskie z prawej strony, ale lepiej wycentrowane

  // ============================================
  // ZNAKI Z OTWARTĄ PRAWĄ STRONĄ
  // ============================================
  // Te znaki mają dużo "powietrza" z prawej, więc lekko w prawo
  J: 0.05,
  a: 0.02,
  e: 0.02,
  u: 0.02,

  // ============================================
  // NAWIASY I ZNAKI INTERPUNKCYJNE
  // ============================================
  // Otwierające - silnie w lewo (wtulają się)
  "(": -0.12,
  "[": -0.12,
  "{": -0.12,

  // Zamykające - silnie w prawo (wypychają)
  ")": 0.12,
  "]": 0.12,
  "}": 0.12,

  // Cudzysłowy i apostrofy - asymetryczne
  // Używamy unikalnych znaków typograficznych jako kluczy
  "‘": -0.08, // Lewy pojedynczy cudzysłów
  "’": 0.08, // Prawy pojedynczy cudzysłów (i apostrof)
  "‚": -0.08, // Pojedynczy cudzysłów dolny
  "“": -0.08, // Lewy podwójny cudzysłów
  "”": 0.08, // Prawy podwójny cudzysłów
  "„": -0.08, // Podwójny cudzysłów dolny
  "'": 0, // Neutralny (prosty) apostrof - często używany jako prawy, więc może być 0.08, ale 0 jest bezpieczniejsze
  '"': 0, // Neutralny (prosty) cudzysłów - wycentrowany

  // Małe znaki interpunkcyjne - lekko w lewo dla lepszego rytmu
  ".": -0.02,
  ",": -0.02,
  ":": -0.02,
  ";": -0.02,

  // ============================================
  // ZNAKI SYMETRYCZNE - neutralne (0)
  // ============================================
  // Te litery mają podobną "masę optyczną" po obu stronach
  B: 0,
  E: 0,
  F: 0,
  H: 0,
  K: 0,
  L: 0,
  M: 0,
  N: 0,
  P: 0,
  R: 0,
  U: 0,
  X: 0,
  Z: 0,
  b: 0,
  h: 0,
  k: 0,
  m: 0,
  n: 0,
  p: 0,
  x: 0,
  z: 0,
  4: 0,

  // Znaki matematyczne i specjalne - wycentrowane
  "-": 0,
  "+": 0,
  "=": 0,
  "*": 0,
  "/": 0,
  "\\": 0,
  "#": 0,
  "&": 0,
  "%": 0,
  $: 0,
  "@": 0,
  "?": 0,
  "^": 0,
  _: 0,
  "~": 0,
  "`": 0,
  "<": 0,
  ">": 0,
};

// Funkcja pomocnicza do bezpiecznego pobierania offsetu
function getOpticalOffset(char) {
  return optical_offsets[char] ?? 0;
}

const narrowVerticals = new Set([
  "l",
  "i",
  "t",
  "f",
  "j",
  "I",
  "J",
  "T",
  "F",
  "1",
  "!",
  "|",
]);

function getOpticalDx(char, bitmapWidth, boxWidth, isFirstCharInLine) {
  const centeredDx = Math.floor((boxWidth - bitmapWidth) / 2);

  // Normalize character to handle accented letters by checking the base character
  const normalizedChar = char.normalize("NFD").replace(/[̀-͡]/g, "");

  // 1. Get base shift from the offset map
  const baseShiftFraction = optical_offsets[normalizedChar] || 0.0;
  let dx = centeredDx + Math.round(boxWidth * baseShiftFraction);

  // 2. Apply Pseudo-Kerning Rule (Specification Section 5)
  if (!isFirstCharInLine && narrowVerticals.has(normalizedChar)) {
    const kerningShift = Math.round(boxWidth * -0.03); // 3% shift left
    dx += kerningShift;
  }

  return dx;
}

/**
 * Renders a single character to the glyph preview canvas using FreeType.
 */
function renderGlyphToCanvas(char) {
  const onScreenCanvas = document.getElementById("glyphCanvas");
  const onScreenCtx = onScreenCanvas.getContext("2d");

  // 1. Get all settings
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

  // Use measured width instead of fontSize for more accurate rendering
  const dimensions = measureOptimalFontDimensions(fontSize);
  const boxWidth = dimensions.width + charSpacing;
  const boxHeight = dimensions.height + lineSpacing;

  onScreenCtx.fillStyle = "#fff";
  onScreenCtx.fillRect(0, 0, onScreenCanvas.width, onScreenCanvas.height);

  if (boxWidth <= 0 || boxHeight <= 0) return;

  // 2. Create an offscreen canvas with the REAL box dimensions
  const offScreenCanvas = document.createElement("canvas");
  offScreenCanvas.width = boxWidth;
  offScreenCanvas.height = boxHeight;
  const ctx = offScreenCanvas.getContext("2d");

  // 3. Render the glyph to the offscreen canvas
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
      if (
        bitmap.width > 0 &&
        bitmap.rows > 0 &&
        bitmap.imagedata &&
        !isWhitespaceOrInvisible(charCode)
      ) {
        let dx = Math.floor((offScreenCanvas.width - bitmap.width) / 2);

        if (useOpticalAlign) {
          // For single glyph preview, treat as first char in line (no kerning)

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

  // 4. Draw the offscreen canvas onto the onscreen canvas, scaled and rotated
  onScreenCtx.imageSmoothingEnabled = false;

  const scale = Math.min(
    onScreenCanvas.width / boxWidth,
    onScreenCanvas.height / boxHeight,
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
      -onScreenCanvas.width / 2,
      -onScreenCanvas.height / 2,
    );
  }

  onScreenCtx.drawImage(offScreenCanvas, destX, destY, destWidth, destHeight);

  if (isVerticalFont) {
    onScreenCtx.restore();
  }
}

/**
 * Renders the preview text to the main preview canvas using FreeType.
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

  // Use measured width instead of fontSize for more accurate rendering
  const dimensions = measureOptimalFontDimensions(fontSize);
  const boxWidth = dimensions.width + charSpacing;
  const boxHeight = dimensions.height + lineSpacing;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ft || !activeFont || boxHeight <= 0) return;

  ft.SetFont(activeFont.family_name, activeFont.style_name);
  ft.SetPixelSize(0, fontSize);

  const loadFlags = getFreetypeLoadFlags();
  const charCodes = [
    ...new Set(previewText.split("").map((c) => c.charCodeAt(0))),
  ];
  const glyphs = ft.LoadGlyphs(charCodes, loadFlags);

  const lines = previewText.split(/\r?\n/);
  let lineY = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let charX = 0;
    lineY += boxHeight;

    if (lineY - boxHeight > canvas.height) break;

    for (let i = 0; i < line.length; i++) {
      const charCode = line.charCodeAt(i);
      const char = line[i];

      // Auto word wrap: if character doesn't fit, move to next line
      if (charX + boxWidth > canvas.width) {
        charX = 0;
        lineY += boxHeight;
        if (lineY - boxHeight > canvas.height) break;
      }

      if (glyphs.has(charCode)) {
        if (shouldRenderBorder) {
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1;
          ctx.strokeRect(
            charX + 0.5,
            lineY - boxHeight + 0.5,
            boxWidth - 1,
            boxHeight - 1,
          );
        }

        const glyph = glyphs.get(charCode);
        const bitmap = glyph.bitmap;

        if (
          bitmap.width > 0 &&
          bitmap.rows > 0 &&
          bitmap.imagedata &&
          !isWhitespaceOrInvisible(charCode)
        ) {
          let dx = charX + Math.floor((boxWidth - bitmap.width) / 2);

          if (useOpticalAlign) {
            // For bin file compatibility, treat each glyph as first-in-line

            // (no pseudo-kerning). This ensures the preview matches the .bin output.

            dx = charX + getOpticalDx(char, bitmap.width, boxWidth, true);
          }

          const lineTop = lineY - boxHeight;
          const baselineOffset = computeBaselineOffset(boxHeight, lineSpacing);
          const baseline = lineTop + baselineOffset;
          const dy = baseline - glyph.bitmap_top;

          const sourceData = bitmap.imagedata.data;
          ctx.fillStyle = "#000";
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              const j = (y * bitmap.width + x) * 4;
              if (shouldRenderPixel(sourceData, j, threshold)) {
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

/**
 * Adds pHYs chunk to PNG to set DPI metadata
 * PNG without pHYs defaults to 72 DPI, causing incorrect physical size
 */
function addDpiToPng(dataURL, dpi) {
  try {
    // Convert data URL to binary
    const base64 = dataURL.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // Calculate pixels per meter from DPI
    // 1 inch = 0.0254 meters, so pixels/meter = DPI / 0.0254
    const pixelsPerMeter = Math.round(dpi / 0.0254);

    // Create pHYs chunk
    // Format: [length(4)] [type(4)] [data(9)] [crc(4)]
    const phys = new Uint8Array(4 + 4 + 9 + 4);

    // Length of data (9 bytes)
    phys[0] = 0;
    phys[1] = 0;
    phys[2] = 0;
    phys[3] = 9;

    // Chunk type: "pHYs"
    phys[4] = 112; // p
    phys[5] = 72; // H
    phys[6] = 89; // Y
    phys[7] = 115; // s

    // Pixels per unit, X axis (4 bytes, big-endian)
    phys[8] = (pixelsPerMeter >>> 24) & 0xff;
    phys[9] = (pixelsPerMeter >>> 16) & 0xff;
    phys[10] = (pixelsPerMeter >>> 8) & 0xff;
    phys[11] = pixelsPerMeter & 0xff;

    // Pixels per unit, Y axis (4 bytes, big-endian)
    phys[12] = (pixelsPerMeter >>> 24) & 0xff;
    phys[13] = (pixelsPerMeter >>> 16) & 0xff;
    phys[14] = (pixelsPerMeter >>> 8) & 0xff;
    phys[15] = pixelsPerMeter & 0xff;

    // Unit specifier: 1 = meter
    phys[16] = 1;

    // Calculate CRC for chunk type + data
    const crcData = phys.slice(4, 17);
    const crc = calculateCRC(crcData);
    phys[17] = (crc >>> 24) & 0xff;
    phys[18] = (crc >>> 16) & 0xff;
    phys[19] = (crc >>> 8) & 0xff;
    phys[20] = crc & 0xff;

    // Find where to insert pHYs (after IHDR chunk)
    // PNG structure: signature(8) + IHDR_length(4) + "IHDR"(4) + IHDR_data(13) + IHDR_crc(4) = 33 bytes
    let insertPos = 8 + 4 + 4 + 13 + 4; // 33 bytes - right after IHDR chunk

    // Create new PNG with pHYs chunk
    const newPng = new Uint8Array(bytes.length + phys.length);
    newPng.set(bytes.slice(0, insertPos), 0);
    newPng.set(phys, insertPos);
    newPng.set(bytes.slice(insertPos), insertPos + phys.length);

    // Convert back to base64
    let binaryString = "";
    for (let i = 0; i < newPng.length; i++) {
      binaryString += String.fromCharCode(newPng[i]);
    }
    return "data:image/png;base64," + btoa(binaryString);
  } catch (error) {
    console.error("Error adding DPI to PNG:", error);
    // Return original if error occurs
    return dataURL;
  }
}

/**
 * CRC-32 calculation for PNG chunks
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
 * Renders live preview on canvas at e-reader resolution (480x800px @ 220 PPI)
 * Canvas is then scaled via CSS transform for correct physical size display
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

  // Use measured width instead of fontSize for more accurate rendering
  const dimensions = measureOptimalFontDimensions(fontSize);
  const boxWidth = dimensions.width + charSpacing;
  const boxHeight = dimensions.height + lineSpacing;

  // Clear canvas with white background
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!ft || !activeFont || boxHeight <= 0) return;

  ft.SetFont(activeFont.family_name, activeFont.style_name);
  ft.SetPixelSize(0, fontSize);

  const loadFlags = getFreetypeLoadFlags();
  const charCodes = [
    ...new Set(previewText.split("").map((c) => c.charCodeAt(0))),
  ];
  const glyphs = ft.LoadGlyphs(charCodes, loadFlags);

  const lines = previewText.split(/\r?\n/);
  let lineY = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let charX = 0;
    lineY += boxHeight;

    if (lineY - boxHeight > canvas.height) break;

    for (let i = 0; i < line.length; i++) {
      const charCode = line.charCodeAt(i);
      const char = line[i];

      // Auto word wrap: if character doesn't fit, move to next line
      if (charX + boxWidth > canvas.width) {
        charX = 0;
        lineY += boxHeight;
        if (lineY - boxHeight > canvas.height) break;
      }

      if (glyphs.has(charCode)) {
        if (shouldRenderBorder) {
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1;
          ctx.strokeRect(
            charX + 0.5,
            lineY - boxHeight + 0.5,
            boxWidth - 1,
            boxHeight - 1,
          );
        }

        const glyph = glyphs.get(charCode);
        const bitmap = glyph.bitmap;

        if (
          bitmap.width > 0 &&
          bitmap.rows > 0 &&
          bitmap.imagedata &&
          !isWhitespaceOrInvisible(charCode)
        ) {
          let dx = charX + Math.floor((boxWidth - bitmap.width) / 2);

          if (useOpticalAlign) {
            dx = charX + getOpticalDx(char, bitmap.width, boxWidth, true);
          }

          const lineTop = lineY - boxHeight;
          const baselineOffset = computeBaselineOffset(boxHeight, lineSpacing);
          const baseline = lineTop + baselineOffset;
          const dy = baseline - glyph.bitmap_top;

          const sourceData = bitmap.imagedata.data;
          ctx.fillStyle = "#000";
          for (let y = 0; y < bitmap.rows; y++) {
            for (let x = 0; x < bitmap.width; x++) {
              const j = (y * bitmap.width + x) * 4;
              if (shouldRenderPixel(sourceData, j, threshold)) {
                ctx.fillRect(dx + x, dy + y, 1, 1);
              }
            }
          }
        }
        charX += boxWidth;
      }
    }
  }

  // Apply scale transform (will be set by slider)
  updateDisplayScale();
}

/**
 * Handles the font file selection.
 */
async function handleFontFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  // 前のフォントをアンロードしてWASMメモリを解放
  if (activeFont) {
    try {
      ft.UnloadFont(activeFont.family_name);
    } catch (e) {
      console.warn("UnloadFont failed:", e);
    }
    activeFont = null;
  }

  const fontBuffer = await file.arrayBuffer();
  try {
    const faces = ft.LoadFontFromBytes(new Uint8Array(fontBuffer));
    if (!faces || faces.length === 0) {
      throw new Error("FreeType could not find any faces in the font file.");
    }
    activeFont = faces[0];

    document.getElementById("fontInfo").innerText =
      `Loaded font: ${activeFont.family_name}, Style: ${activeFont.style_name}`;

    // Measure optimal width and display recommendation
    const currentFontSize =
      parseInt(document.getElementById("fontSize").value, 10) || 28;
    const currentCharSpacing =
      parseInt(document.getElementById("charSpacing").value, 10) || 0;
    const dimensions = measureOptimalFontDimensions(currentFontSize);
    const finalWidth = dimensions.width + currentCharSpacing;
    const finalHeight =
      dimensions.height +
        parseInt(document.getElementById("lineSpacing").value, 10) || 0;

    // create or update diagnostics box
    try {
      let di = document.getElementById("diagnostics");
      if (!di) {
        di = document.createElement("div");
        di.id = "diagnostics";
        di.style.marginTop = "8px";
        di.style.fontSize = "0.9em";
        di.style.color = "#444";
        di.innerHTML = `<div><strong>診断情報</strong></div>
                    <div>FreeType: <span class="ft">不明</span></div>
                    <div>フォント: <span class="font">未選択</span></div>
                    <div>最適サイズ（測定値）: <span class="measured">不明</span></div>
                    <div>最終サイズ (幅×高さ): <span class="final">不明</span></div>
                    <div>プレビュー文字数: <span class="plen">0</span></div>
                    <div>最終レンダリング: <span class="last">未実行</span></div>`;
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
      console.warn("diag create failed", e);
    }

    updateControlStates();
    renderGlyphToCanvas("A");
    renderPreviewText();
    renderRealSizePreview();
  } catch (err) {
    document.getElementById("fontInfo").innerText =
      "フォントの読み込みに失敗しました。" + (err && err.message ? err.message : err);
    activeFont = null;
    console.error("Font parse error:", err);
  }
}

/**
 * Converts the loaded font to a binary file.
 */
async function convertFontToBin() {
  if (!activeFont) {
    alert("TTFまたはOTFフォントファイルを選択してください。");
    return;
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

  // Measure optimal width based on actual character rendering (like C# does)
  const dimensions = measureOptimalFontDimensions(fontSize);
  const width = dimensions.width + charSpacing;
  const height = dimensions.height + lineSpacing;

  if (width <= 0 || height <= 0) {
    alert("幅と高さは1px以上になるように設定してください。");
    return;
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

      // 縦書き時：キャッシュから縦向きグリフを取得
      let activeGlyph = glyph;
      if (isVerticalFont && VERTICAL_CHAR_MAP.has(charCode)) {
        const vCode = VERTICAL_CHAR_MAP.get(charCode);
        if (verticalGlyphCache.has(vCode) && verticalGlyphCache.get(vCode).bitmap?.width > 0) {
          activeGlyph = verticalGlyphCache.get(vCode);
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      if (shouldRenderBorder) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
      }

      if (activeGlyph.bitmap && activeGlyph.bitmap.width > 0 && activeGlyph.bitmap.rows > 0) {
        if (!isWhitespaceOrInvisible(charCode)) {
          let dx = Math.floor((width - activeGlyph.bitmap.width) / 2);

          if (useOpticalAlign) {
            dx = getOpticalDx(char, activeGlyph.bitmap.width, width, true);
          }

          const baseline = computeBaselineOffset(height, lineSpacing);
          const dy = baseline - activeGlyph.bitmap_top;

          const sourceData = activeGlyph.bitmap.imagedata.data;
          ctx.fillStyle = "#000";
          for (let y = 0; y < activeGlyph.bitmap.rows; y++) {
            for (let x = 0; x < activeGlyph.bitmap.width; x++) {
              const pixelIndex = (y * activeGlyph.bitmap.width + x) * 4;
              if (shouldRenderPixel(sourceData, pixelIndex, threshold)) {
                ctx.fillRect(dx + x, dy + y, 1, 1);
              }
            }
          }
        }
      }

      const finalImageData = ctx.getImageData(0, 0, width, height).data;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pixelIndex = (y * width + x) * 4;
          const bit = finalImageData[pixelIndex] < 128 ? 1 : 0;

          if (bit) {
            let finalByteIdx, finalBitIdx;
            if (isVerticalFont) {
              // 縦書き: 90度回転。x軸反転してミラーを修正
              const rx = width - 1 - x;
              finalByteIdx = charCode * charByte + rx * widthByte + (y >> 3);
              finalBitIdx = 7 - (y % 8);
            } else {
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

// Read blob to base64 (no data: prefix)
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
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Properly base64-encode a UTF-8 string in browsers
function base64EncodeUnicode(str) {
  // encodeURIComponent -> percent-encodings -> convert to raw bytes
  return btoa(
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
    return;
  }
  const { blob, width, height } = res;

  status.textContent = "Preparing e-reader screen preview...";
  const previewCanvas = document.getElementById("realSizeCanvas");
  const previewBlob = await new Promise((r) =>
    previewCanvas.toBlob(r, "image/png"),
  );

  // Create a small thumbnail for gallery listing (max dimension 360px)
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
    // White background
    tctx.fillStyle = "#fff";
    tctx.fillRect(0, 0, tw, th);
    tctx.drawImage(canvas, 0, 0, w, h, 0, 0, tw, th);

    // update diagnostics preview length and last render
    try {
      const di = document.getElementById("diagnostics");
      if (di) {
        di.querySelector(".plen").textContent = previewText.length;
        di.querySelector(".last").textContent = new Date().toLocaleTimeString();
      }
    } catch (e) {
      /* ignore */
    }
    return tmp;
  }

  const thumbCanvas = createThumbnail(previewCanvas, 360);
  const thumbBlob = await new Promise((r) =>
    thumbCanvas.toBlob(r, "image/png"),
  );

  status.textContent = "Encoding e-reader preview...";
  const binBase64 = await readBlobAsBase64(blob);
  const previewBase64 = await readBlobAsBase64(previewBlob);
  const thumbBase64 = await readBlobAsBase64(thumbBlob);

  // Pre-upload check: inform user if bin is too large for server default
  const binBytes = blob.size || Math.floor((binBase64.length * 3) / 4);
  const SERVER_MAX_BIN = 12 * 1024 * 1024; // 12B client-side expectation (matches server default)
  if (binBytes > SERVER_MAX_BIN) {
    const mb = (binBytes / (1024 * 1024)).toFixed(2);
    alert(
      `Generated .bin file is ${mb} MB which exceeds the configured server limit (~${SERVER_MAX_BIN / (1024 * 1024)} MB). Please reduce font size/spacing or enable different settings. Alternatively increase server MAX_BIN_BYTES.`,
    );
    status.textContent = "Error: .bin file too large for server";
    return;
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
    id: slug,
    family,
    style,
    preview_text: previewText,
    width,
    height,
    timestamp: new Date().toISOString(),
    submitter: { name: submitter },
  };

  const files = {};
  files[`${folder}/metadata.json`] = base64EncodeUnicode(
    JSON.stringify(metadata, null, 2),
  );
  files[`${folder}/preview.png`] = previewBase64;
  files[`${folder}/preview_thumb.png`] = thumbBase64;
  files[`${folder}/font_${width}x${height}.bin`] = binBase64;

  status.textContent = "Uploading to server...";
  try {
    // Prepare an AbortController so the request doesn't hang indefinitely
    const controller = new AbortController();
    const timeoutMs = 30000; // 30s
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Debug: log approximate payload sizes
    try {
      const metaSize = files[`${folder}/metadata.json`].length;
      const previewSize = files[`${folder}/preview.png`].length;
      const binSize = files[`${folder}/font_${width}x${height}.bin`].length;
      console.log("Upload payload sizes (base64 chars):", {
        metaSize,
        previewSize,
        binSize,
      });
    } catch (e) {
      console.warn("Failed to compute payload sizes", e);
    }

    // Auto-target repo (no prompt)
    const repoFull = "lakafior/XTEink-Web-Font-Maker";
    const [owner, repo] = repoFull.split("/");
    const resp = await fetch(`${API_BASE}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner,
        repo,
        slug,
        files,
        family,
        style,
        preview_text: previewText,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || JSON.stringify(j));
    status.textContent = "";
    alert("PR created: " + j.pr);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("Upload timed out after 30s");
      status.textContent =
        "Error: upload timed out (no response from server). Check tunnel / server.";
      return;
    }
    console.error(err);
    status.textContent = "Error: " + (err && err.message ? err.message : err);
  }
}

document
  .getElementById("saveServerBtn")
  ?.addEventListener("click", saveToServer);

function updateControlStates() {
  const isAntiAlias = document.getElementById("chkRenderAntiAlias").checked;
  document.getElementById("lightnessThreshold").disabled = !isAntiAlias;
  document.getElementById("lightnessThresholdValue").style.opacity = isAntiAlias
    ? 1
    : 0.5;
}

/**
 * Updates the measured width display in diagnostics when fontSize changes
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
    dimensions.height +
    (parseInt(document.getElementById("lineSpacing").value, 10) || 0);

  try {
    const di = document.getElementById("diagnostics");
    if (di) {
      const measuredEl = di.querySelector(".measured");
      const finalEl = di.querySelector(".final");

      if (measuredEl) {
        measuredEl.textContent = `${dimensions.width}px × ${dimensions.height}px`;
      }
      if (finalEl) {
        finalEl.textContent = `${finalWidth}px × ${finalHeight}px (${dimensions.width}+${currentCharSpacing} × ${dimensions.height}+${parseInt(document.getElementById("lineSpacing").value, 10) || 0})`;
      }
    }
  } catch (e) {
    console.warn("Failed to update measured width", e);
  }
}

// --- Event Listeners ---
document
  .getElementById("fontFile")
  .addEventListener("change", handleFontFileChange);
document
  .getElementById("convertBtn")
  .addEventListener("click", convertFontToBin);

const inputs = [
  "charSpacing",
  "lineSpacing",
  "fontSize",
  "isVerticalFont",
  "lightnessThreshold",
  "chkRenderAntiAlias",
  "chkRenderGridFit",
  "chkRenderBorder",
  "chkOpticalAlign",
];
const previewEl = document.getElementById("previewText");
const previewCount = document.getElementById("previewCount");
const PREVIEW_MAX = 500;

function updatePreviewCount() {
  const remaining =
    PREVIEW_MAX - (previewEl.value ? previewEl.value.length : 0);
  previewCount.textContent = `残り${remaining}文字`;
}

// prevent paste that exceeds maxlength
previewEl.addEventListener("paste", (e) => {
  const paste = (e.clipboardData || window.clipboardData).getData("text");
  const willBe = (previewEl.value || "") + paste;
  if (willBe.length > PREVIEW_MAX) {
    e.preventDefault();
    // trim paste to remaining
    const allowed =
      PREVIEW_MAX - (previewEl.value ? previewEl.value.length : 0);
    if (allowed > 0) {
      const trimmed = paste.slice(0, allowed);
      const start = previewEl.selectionStart || previewEl.value.length;
      const before = previewEl.value.slice(0, start);
      const after = previewEl.value.slice(previewEl.selectionEnd || start);
      previewEl.value = before + trimmed + after;
      // move caret
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
  if (element) {
    element.addEventListener("input", () => {
      updateControlStates();
      renderPreviewText();
      renderRealSizePreview();
      renderGlyphToCanvas("A");

      // Update measured width when fontSize or charSpacing changes
      if (id === "fontSize" || id === "charSpacing") {
        updateMeasuredWidth();
      }
    });
  }
});

// also wire previewText into rendering and controls
if (previewEl) {
  previewEl.addEventListener("input", () => {
    updateControlStates();
    renderPreviewText();
    renderRealSizePreview();
    renderGlyphToCanvas("A");
  });
  // initialize counter
  updatePreviewCount();
}

document.getElementById("lightnessThreshold").addEventListener("input", (e) => {
  document.getElementById("lightnessThresholdValue").textContent =
    e.target.value;
});

// Resize text preview on window resize
window.addEventListener("resize", () => {
  renderPreviewText();
  renderRealSizePreview();
});

// Export preview as PNG button
document.getElementById("exportPreviewBtn")?.addEventListener("click", () => {
  const canvas = document.getElementById("realSizeCanvas");
  if (!canvas) return;

  const dataURL = canvas.toDataURL("image/png");
  const fontSize = document.getElementById("fontSize").value || "28";
  const fontName = activeFont
    ? `${activeFont.family_name}-${activeFont.style_name}`
    : "font";
  const filename = `${slugify(fontName)}-${fontSize}px-preview-480x800.png`;

  const a = document.createElement("a");
  a.href = dataURL;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  const statusEl = document.getElementById("calibrationStatus");
  if (statusEl) {
    const originalText = statusEl.textContent;
    statusEl.textContent = `✓ Exported: ${filename}`;
    statusEl.style.color = "#4caf50";
    statusEl.style.fontWeight = "bold";

    setTimeout(() => {
      statusEl.textContent = originalText;
      statusEl.style.color = "#888";
      statusEl.style.fontWeight = "normal";
    }, 3000);
  }
});

// Auto-detect monitor DPI and suggest scale
function autoDetectScale() {
  if (!displayScaleSlider) return;

  // Check if user has previously calibrated their display
  const savedScale = localStorage.getItem("ereaderPreviewScale");

  if (savedScale) {
    // Use saved calibration
    const scale = parseInt(savedScale, 10);
    displayScaleSlider.value = scale.toString();

    const statusEl = document.getElementById("calibrationStatus");
    if (statusEl) {
      statusEl.innerHTML = `✓ <strong>保存済みキャリブレーション: ${scale}%</strong> - 必要に応じてスライダーで調整してください`;
      statusEl.style.color = "#4caf50";
    }
    return;
  }

  // Try to detect actual screen DPI
  const dpr = window.devicePixelRatio || 1;

  let suggestedScale = 100;

  if (dpr >= 2) {
    // Retina/HiDPI display - suggest larger scale
    suggestedScale = Math.round(100 * 1.4); // 140%
  } else if (dpr > 1 && dpr < 2) {
    suggestedScale = Math.round(100 * (1 + (dpr - 1) * 0.8)); // Interpolate
  }

  displayScaleSlider.value = suggestedScale.toString();

  const statusEl = document.getElementById("calibrationStatus");
  if (statusEl && suggestedScale !== 100) {
    statusEl.innerHTML = `💡 表示スケールを${suggestedScale}%に自動設定しました - 定規で実際のサイズを確認しながら調整して保存してください`;
    statusEl.style.color = "#ff9800";
  }
}

// Display scale slider for real-size preview
const displayScaleSlider = document.getElementById("displayScale");
const displayScaleValue = document.getElementById("displayScaleValue");
const realSizeCanvas = document.getElementById("realSizeCanvas");

function updateDisplayScale() {
  if (!displayScaleSlider || !realSizeCanvas) return;

  const scale = parseInt(displayScaleSlider.value, 10) / 100;

  // スケールはCSS(width:100%)で制御するためJSでは変更不要
  realSizeCanvas.style.transform = "";

  if (displayScaleValue) {
    displayScaleValue.textContent = (scale * 100).toFixed(0) + "%";
  }

  // Update info text
  const infoEl = document.getElementById("previewDimensionsInfo");
  if (infoEl) {
    const actualWidth = Math.round(55 * scale * 10) / 10;
    const actualHeight = Math.round(93 * scale * 10) / 10;
    infoEl.textContent = `現在の表示サイズ: ${actualWidth}mm × ${actualHeight}mm（55mm × 93mmに合わせてください）`;
  }
}

displayScaleSlider?.addEventListener("input", updateDisplayScale);

// Save Calibration button
document.getElementById("saveCalibration")?.addEventListener("click", () => {
  if (!displayScaleSlider) return;

  const scalePercent = parseInt(displayScaleSlider.value, 10);
  localStorage.setItem("ereaderPreviewScale", scalePercent.toString());

  const statusEl = document.getElementById("calibrationStatus");
  if (statusEl) {
    statusEl.innerHTML = `<strong>✓ Calibration saved! (${scalePercent}%)</strong> This scale will be used automatically next time.`;
    statusEl.style.color = "#4caf50";
    statusEl.style.fontWeight = "bold";

    // Reset style after 5 seconds
    setTimeout(() => {
      if (statusEl) {
        statusEl.innerHTML = `✓ <strong>キャリブレーションを保存しました: ${scalePercent}%</strong>`;
        statusEl.style.fontWeight = "normal";
      }
    }, 5000);
  }
});

// Reset button - clears saved calibration and uses auto-detect
document.getElementById("resetDisplayScale")?.addEventListener("click", () => {
  if (displayScaleSlider) {
    // Clear saved calibration
    localStorage.removeItem("ereaderPreviewScale");

    // Re-run auto-detection
    autoDetectScale();
    updateDisplayScale();

    const statusEl = document.getElementById("calibrationStatus");
    if (statusEl) {
      statusEl.innerHTML =
        "💡 キャリブレーションをリセットしました。自動検出を適用中 - 定規で確認しながらスライダーを調整して保存してください";
      statusEl.style.color = "#ff9800";
    }
  }
});

// Set initial state on load
updateControlStates();

// Initialize real-size preview with auto-detect
autoDetectScale();
updateDisplayScale();

// --- Developer helper: verify bin glyphs match preview ---
// Usage (in console): verifyBinMatchesPreview(['A','a','0']);
window.verifyBinMatchesPreview = async function (
  chars = ["A", "a", "0"],
  show = false,
) {
  if (!activeFont) {
    console.warn("No font loaded. Load a font first.");
    return;
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
    canvas.width = width;
    canvas.height = height;
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
      if (
        glyph &&
        glyph.bitmap &&
        glyph.bitmap.width > 0 &&
        glyph.bitmap.rows > 0 &&
        glyph.bitmap.imagedata
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
    return canvas;
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
    canvas.width = width;
    canvas.height = height;
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
    return canvas;
  }

  for (const ch of chars) {
    const orig = renderGlyphOffscreen(ch);
    const packed = packCanvasToBinBytes(orig);
    const unpacked = unpackBinBytesToCanvas(packed.bytes, width, height);

    // compare pixel-wise
    const a = orig.getContext("2d").getImageData(0, 0, width, height).data;
    const b = unpacked.getContext("2d").getImageData(0, 0, width, height).data;
    let mismatch = 0;
    for (let i = 0; i < a.length; i += 4) {
      const aa = a[i] < 128 ? 1 : 0;
      const bb = b[i] < 128 ? 1 : 0;
      if (aa !== bb) mismatch++;
    }
    if (mismatch === 0)
      console.log(`OK: '${ch}' matches exactly (${width}x${height})`);
    else
      console.warn(
        `MISMATCH: '${ch}' has ${mismatch} differing pixels (${width}x${height})`,
      );
    // expose canvases for manual inspection in console
    console.log("original canvas:", orig);
    console.log("unpacked canvas:", unpacked);

    if (show) {
      try {
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
          title.textContent = "verifyBinMatchesPreview results";
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
        l1.textContent = "original";
        l1.style.fontSize = "11px";
        l1.style.textAlign = "center";
        wrapOrig.appendChild(l1);
        wrapOrig.appendChild(orig);
        const a1 = document.createElement("a");
        a1.textContent = "download";
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
        a2.textContent = "download";
        a2.href = unpacked.toDataURL("image/png");
        a2.download = `${ch}-unpacked.png`;
        wrapUn.appendChild(a2);
        block.appendChild(wrapUn);

        container.appendChild(block);
      } catch (e) {
        console.warn("Failed to render compare UI", e);
      }
    }
  }
};
// also expose on globalThis for console environments where window may not be the global
try {
  globalThis.verifyBinMatchesPreview = window.verifyBinMatchesPreview;
} catch (e) {
  /* ignore */
}
