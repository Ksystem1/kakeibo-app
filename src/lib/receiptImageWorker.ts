/**
 * レシート取込: メインスレッドを止めないための画像圧縮専用 Worker
 * 長辺 1000px ・ JPEG 品質 0.66（本番の async アップロード用）
 */
export const ASYNC_MAX_EDGE = 1000;
export const ASYNC_JPEG_QUALITY = 0.66;

type WorkerIn = { arrayBuffer: ArrayBuffer; mime: string };
type WorkerOut =
  | { ok: true; arrayBuffer: ArrayBuffer; width: number; height: number }
  | { ok: false; message: string };

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const run = async () => {
    const { arrayBuffer, mime } = ev.data;
    const t = (mime || "image/jpeg").toLowerCase();
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([arrayBuffer], { type: t || "image/jpeg" }));
    } catch {
      self.postMessage({ ok: false, message: "画像を読み込めませんでした。" } satisfies WorkerOut);
      return;
    }
    try {
      const w0 = bitmap.width;
      const h0 = bitmap.height;
      if (w0 <= 0 || h0 <= 0) {
        self.postMessage({ ok: false, message: "画像のサイズが無効です。" } satisfies WorkerOut);
        return;
      }
      const longEdge = Math.max(w0, h0);
      let w = w0;
      let h = h0;
      if (longEdge > ASYNC_MAX_EDGE) {
        const s = ASYNC_MAX_EDGE / longEdge;
        w = Math.round(w0 * s);
        h = Math.round(h0 * s);
      }
      if (typeof OffscreenCanvas === "undefined") {
        self.postMessage({ ok: false, message: "OffscreenCanvas 未対応" } satisfies WorkerOut);
        return;
      }
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        self.postMessage({ ok: false, message: "画像の描画に失敗しました。" } satisfies WorkerOut);
        return;
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: "image/jpeg", quality: ASYNC_JPEG_QUALITY });
      if (!out) {
        self.postMessage({ ok: false, message: "JPEG 変換に失敗しました。" } satisfies WorkerOut);
        return;
      }
      const ab = await out.arrayBuffer();
      const msg: WorkerOut = { ok: true, arrayBuffer: ab, width: w, height: h };
      (self as unknown as { postMessage(m: WorkerOut, t: Transferable[]): void }).postMessage(
        msg,
        [ab],
      );
    } finally {
      bitmap.close();
    }
  };
  void run();
};

export {};
