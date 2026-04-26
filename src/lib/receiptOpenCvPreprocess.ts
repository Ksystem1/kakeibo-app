/**
 * OpenCV.wasm: 台形補正の試行、グレースケール、ノイズ低減（median）、適応的二値化。
 * 成功したら true（引数の canvas ピクセルを上書き）。失敗は false（Canvas 2D へフォールバック）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any;

let cvLoad: Promise<Cv> | null = null;

function getCv(): Promise<Cv> {
  if (!cvLoad) {
    cvLoad = (async () => {
      const mod = await import("@techstark/opencv-js");
      return (await mod.default) as Cv;
    })();
  }
  return cvLoad;
}

function z(
  ...objs: Array<{ delete?: () => void } | null | undefined>
) {
  for (const obj of objs) {
    try {
      obj?.delete?.();
    } catch {
      /* */
    }
  }
}

const PROC_MAX = 1280;
const CAND_W = 640;
const MIN_QUAD = 0.1;

type Pt = { x: number; y: number };

function order4(pts: Pt[]) {
  pts.sort((a, b) => a.y - b.y);
  const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = pts.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0]!, top[1]!, bot[1]!, bot[0]!] as [Pt, Pt, Pt, Pt];
}

/**
 * 輪郭から一番大きい四角候補で正面化。不適合なら null
 */
function tryUnwarpRgba(cv: Cv, srcRgba: Cv): Cv | null {
  const s = new cv.Mat();
  const sGray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const cont = new cv.MatVector();
  const hier = new cv.Mat();
  try {
    const sw = Math.max(32, CAND_W);
    const sh = Math.round((srcRgba.rows / srcRgba.cols) * sw);
    cv.resize(srcRgba, s, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    cv.cvtColor(s, sGray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(sGray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 30, 90, 3, false);
    cv.findContours(edges, cont, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const imgA = sw * sh;
    let best: Cv | null = null;
    let bestArea = 0;
    for (let i = 0; i < cont.size(); i += 1) {
      const c0 = cont.get(i);
      const p = cv.arcLength(c0, true);
      const a = new cv.Mat();
      cv.approxPolyDP(c0, a, 0.045 * p, true);
      c0.delete();
      if (a.rows === 4) {
        const ar = Math.abs(cv.contourArea(a, false));
        if (ar > bestArea && ar > imgA * MIN_QUAD) {
          if (best) best.delete();
          best = a;
          bestArea = ar;
        } else {
          a.delete();
        }
      } else {
        a.delete();
      }
    }
    if (!best) return null;
    const pts4: Pt[] = [];
    for (let j = 0; j < 4; j += 1) {
      pts4.push({ x: best.data32S[j * 2]!, y: best.data32S[j * 2 + 1]! });
    }
    const [tl, tr, br, bl] = order4(pts4);
    z(best);
    const scaleX = srcRgba.cols / sw;
    const scaleY = srcRgba.rows / sh;
    const tlc = (p: Pt) => ({ x: p.x * scaleX, y: p.y * scaleY });
    const t = tlc(tl);
    const r = tlc(tr);
    const b = tlc(br);
    const l = tlc(bl);
    const wTop = Math.hypot(r.x - t.x, r.y - t.y);
    const wBot = Math.hypot(b.x - l.x, b.y - l.y);
    const hL = Math.hypot(l.x - t.x, l.y - t.y);
    const hR = Math.hypot(b.x - r.x, b.y - r.y);
    const W = Math.max(1, Math.round(Math.max(wTop, wBot)));
    const H = Math.max(1, Math.round(Math.max(hL, hR)));
    if (W < 100 || H < 100 || W > 5200 || H > 5200) return null;
    const srcM = cv.matFromArray(4, 1, cv.CV_32FC2, [t.x, t.y, r.x, r.y, b.x, b.y, l.x, l.y]);
    const dstM = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(srcM, dstM);
    const out = new cv.Mat();
    cv.warpPerspective(
      srcRgba,
      out,
      M,
      new cv.Size(W, H),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    z(srcM, dstM, M);
    return out;
  } catch {
    return null;
  } finally {
    z(s, sGray, blur, edges, cont, hier);
  }
}

export async function runOpenCvReceiptPreprocess(canvas: HTMLCanvasElement): Promise<boolean> {
  if (typeof document === "undefined" || !canvas.getContext) return false;
  let cv: Cv;
  try {
    cv = await getCv();
  } catch {
    return false;
  }
  const w0 = canvas.width;
  const h0 = canvas.height;
  if (w0 < 16 || h0 < 16) return false;
  const long0 = Math.max(w0, h0);
  let cvs: HTMLCanvasElement = canvas;
  if (long0 > PROC_MAX) {
    const sc = PROC_MAX / long0;
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(w0 * sc));
    small.height = Math.max(1, Math.round(h0 * sc));
    const cx = small.getContext("2d");
    if (!cx) return false;
    cx.drawImage(canvas, 0, 0, small.width, small.height);
    cvs = small;
  }
  let srcRgba: Cv;
  try {
    srcRgba = cv.imread(cvs) as Cv;
  } catch {
    return false;
  }

  const unw = tryUnwarpRgba(cv, srcRgba);
  let m: Cv = srcRgba;
  if (unw) {
    z(srcRgba);
    m = unw;
  }
  const g = new cv.Mat();
  const md = new cv.Mat();
  const th = new cv.Mat();
  try {
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY, 0);
    z(m);
    cv.medianBlur(g, md, 3);
    z(g);
    cv.adaptiveThreshold(md, th, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 19, 6);
    z(md);
    cv.imshow(canvas, th);
    z(th);
    return true;
  } catch {
    z(m, g, md, th);
    return false;
  }
}
