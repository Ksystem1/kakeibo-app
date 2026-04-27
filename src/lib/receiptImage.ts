/** レシート用: ブラウザで JPEG に正規化し、長辺を抑えて base64 を返す */

/**
 * アップロード・通信時間短縮のため長辺 1000px 程度＋中品質 JPEG（Textract/ Bedrock とも可読性は維持）
 */
const MAX_EDGE = 1000;
const JPEG_QUALITY = 0.66;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

function readAsDataUrlBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const i = s.indexOf(",");
      if (i < 0) reject(new Error("画像の変換に失敗しました。"));
      else resolve(s.slice(i + 1));
    };
    r.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    r.readAsDataURL(blob);
  });
}

/** createImageBitmap 非対応時は JPEG/PNG のみ data URL 経由で送る */
async function legacyImageBase64(file: File): Promise<string> {
  const t = (file.type || "").toLowerCase();
  if (t !== "image/jpeg" && t !== "image/jpg" && t !== "image/png") {
    throw new Error(
      "この環境では画像の変換に未対応です。JPEG または PNG で保存してから選び直すか、別のブラウザ（Safari 等）でお試しください。",
    );
  }
  return readAsDataUrlBase64(file);
}

/**
 * OCR 向けの軽量プリプロセス: グレースケール＋明るさの正規化（暗い室内撮影の文字コントラスト補正）。
 * 幾何の歪み補正は OpenCV.wasm 等の追加を想定（本関数は2D API のみ）。
 */
function applyOcrPreprocessToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    data[i] = data[i + 1] = data[i + 2] = y;
  }
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = data[i]!;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = max - min || 1;
  for (let i = 0; i < data.length; i += 4) {
    const v = ((data[i]! - min) / range) * 255;
    const t = v < 0 ? 0 : v > 255 ? 255 : v;
    data[i] = data[i + 1] = data[i + 2] = t;
  }
  const imageData = new ImageData(data, width, height);
  ctx.putImageData(imageData, 0, 0);
}

async function tryOpenCvPipeline(canvas: HTMLCanvasElement) {
  try {
    const { runOpenCvReceiptPreprocess } = await import("./receiptOpenCvPreprocess");
    return await runOpenCvReceiptPreprocess(canvas);
  } catch {
    return false;
  }
}

/**
 * レシート画像を API 送信用の base64（生データ、data URL プレフィックスなし）にする。
 */
export async function prepareReceiptImageForApi(file: File): Promise<string> {
  if (!file.size) {
    throw new Error("空のファイルです。");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("画像が大きすぎます（20MB以下にしてください）。");
  }

  if (typeof createImageBitmap !== "function") {
    return legacyImageBase64(file);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "画像を読み込めませんでした。iPhone の「写真」で「互換性優先（JPEG）」にするか、JPEG/PNG で書き出してから選び直してください。",
    );
  }

  try {
    let { width, height } = bitmap;
    if (width <= 0 || height <= 0) {
      throw new Error("画像のサイズが無効です。");
    }
    const longEdge = Math.max(width, height);
    if (longEdge > MAX_EDGE) {
      const scale = MAX_EDGE / longEdge;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("画像処理に失敗しました。");
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    const openCvOk = await tryOpenCvPipeline(canvas);
    if (!openCvOk) {
      applyOcrPreprocessToCanvas(ctx, width, height);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) {
      throw new Error("画像の JPEG 変換に失敗しました。");
    }
    return readAsDataUrlBase64(blob);
  } finally {
    bitmap.close();
  }
}

/** 非同期アップロード用: Worker と同じ長辺・品質（OCR 前処理は行わない） */
const ASYNC_MAX_EDGE = 1000;
const ASYNC_JPEG_QUALITY = 0.66;
const ASYNC_MAX_INPUT_BYTES = 20 * 1024 * 1024;

async function compressReceiptFileToJpegBlobOnMainThread(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    let w = bitmap.width;
    let h = bitmap.height;
    if (w <= 0 || h <= 0) throw new Error("画像のサイズが無効です。");
    const longEdge = Math.max(w, h);
    if (longEdge > ASYNC_MAX_EDGE) {
      const s = ASYNC_MAX_EDGE / longEdge;
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像処理に失敗しました。");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", ASYNC_JPEG_QUALITY),
    );
    if (!blob) throw new Error("画像の JPEG 変換に失敗しました。");
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * 撮影・ファイル選択直後: Web Worker でリサイズ＋JPEG 圧縮（メインをブロックしない）。
 * 失敗時は createImageBitmap 可能ならメインで同条件にフォールバック。プレビュー用 Blob。
 */
export async function compressReceiptFileToJpegBlob(file: File): Promise<Blob> {
  if (!file.size) throw new Error("空のファイルです。");
  if (file.size > ASYNC_MAX_INPUT_BYTES) {
    throw new Error("画像が大きすぎます（20MB以下にしてください）。");
  }

  const runWorker = (): Promise<Blob> => {
    const w = new Worker(new URL("./receiptImageWorker.ts", import.meta.url), { type: "module" });
    return (async () => {
      const arrayBuffer = await file.arrayBuffer();
      return new Promise<Blob>((resolve, reject) => {
        w.onmessage = (
          ev: MessageEvent<{ ok?: boolean; arrayBuffer?: ArrayBuffer; message?: string }>,
        ) => {
          w.terminate();
          const d = ev.data;
          if (d && d.ok && d.arrayBuffer) {
            resolve(new Blob([d.arrayBuffer], { type: "image/jpeg" }));
            return;
          }
          reject(new Error(d?.message || "WORKER"));
        };
        w.onerror = (err) => {
          w.terminate();
          reject(err);
        };
        w.postMessage(
          { arrayBuffer, mime: file.type || "image/jpeg" },
          [arrayBuffer],
        );
      });
    })();
  };

  try {
    return await runWorker();
  } catch {
    if (typeof createImageBitmap === "function") {
      return compressReceiptFileToJpegBlobOnMainThread(file);
    }
    const b64 = await legacyImageBase64(file);
    const bin = globalThis.atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i) & 0xff;
    return new Blob([u8], { type: "image/jpeg" });
  }
}
