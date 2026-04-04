/** レシート用: ブラウザで JPEG に正規化し、長辺を抑えて Textract が扱いやすい base64 を返す */

/** Textract 向けに長辺をやや大きめに保ち、店名・細字の読み取りを助ける */
const MAX_EDGE = 2560;
const JPEG_QUALITY = 0.9;
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
