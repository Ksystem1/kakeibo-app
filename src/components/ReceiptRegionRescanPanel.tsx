import { useCallback, useId, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import styles from "./KakeiboDashboard.module.css";

const MIN_CROP_PX = 32;

type DragBox = { x1: number; y1: number; x2: number; y2: number } | null;

/** フォームの日付・金額・メモと同じ state を渡し、画像上にプレビュー表示する */
export type ReceiptImageResultPreview = {
  date: string;
  total: string;
  memo: string;
};

function formatDateForImageOverlay(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
    }
  }
  return t;
}

function formatTotalForImageOverlay(raw: string): string {
  const s = raw.replace(/[, 　]/g, "").trim();
  if (!s) return "";
  const n = Number.parseFloat(s);
  if (Number.isFinite(n)) return `¥${n.toLocaleString("ja-JP")}`;
  return raw.trim();
}

type Props = {
  imageObjectUrl: string;
  busy: boolean;
  onCroppedFile: (file: File) => void;
  /** 右カラムのフォームと同じ取り込み結果。画像列にも重ね表示する。 */
  resultPreview?: ReceiptImageResultPreview;
  /** 圧縮中・本番前アップロード中など（画像上に優先表示） */
  ingestStatusMessage?: string | null;
  /** ジョブ受付後・解析未完了。値がまだ空のとき待機文を出す用 */
  parsingOcr?: boolean;
};

/**
 * レシート上の金額エリア等を囲み、その部分だけを新しい画像として再OCR用に切り出す。
 */
export function ReceiptRegionRescanPanel({
  imageObjectUrl,
  busy,
  onCroppedFile,
  resultPreview,
  ingestStatusMessage,
  parsingOcr = false,
}: Props) {
  const helpId = useId();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [drag, setDrag] = useState<DragBox>(null);
  const [err, setErr] = useState<string | null>(null);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    e.preventDefault();
    const img = imgRef.current;
    if (!img) return;
    const b = img.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    setErr(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x1: x, y1: y, x2: x, y2: y });
  }, [busy]);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!drag || busy) return;
      const img = imgRef.current;
      if (!img) return;
      const b = img.getBoundingClientRect();
      setDrag((d) => {
        if (!d) return d;
        return {
          ...d,
          x2: e.clientX - b.left,
          y2: e.clientY - b.top,
        };
      });
    },
    [drag, busy],
  );

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const box = drag
    ? (() => {
        const img = imgRef.current;
        if (!img) return null;
        const w = img.getBoundingClientRect().width;
        const h = img.getBoundingClientRect().height;
        if (!w || !h) return null;
        const x = Math.max(0, Math.min(drag.x1, drag.x2, w - 0.1));
        const y = Math.max(0, Math.min(drag.y1, drag.y2, h - 0.1));
        const bw = Math.abs(drag.x2 - drag.x1);
        const bh = Math.abs(drag.y2 - drag.y1);
        return { left: x, top: y, w: Math.min(bw, w - x), h: Math.min(bh, h - y) };
      })()
    : null;

  const canSubmit =
    box && box.w >= MIN_CROP_PX && box.h >= MIN_CROP_PX && !busy && !err;

  const dRaw = (resultPreview?.date ?? "").trim();
  const totalRaw = (resultPreview?.total ?? "").trim();
  const memoRaw = (resultPreview?.memo ?? "").trim();
  const hasResultValues = Boolean(dRaw || totalRaw || memoRaw);
  const displayDate = formatDateForImageOverlay(dRaw);
  const displayTotal = formatTotalForImageOverlay(totalRaw);
  const showResultOverlay = Boolean(ingestStatusMessage) || hasResultValues || (parsingOcr && !ingestStatusMessage);

  const doCrop = useCallback(() => {
    if (!box) return;
    if (box.w < MIN_CROP_PX || box.h < MIN_CROP_PX) {
      setErr(`囲いを ${MIN_CROP_PX}×${MIN_CROP_PX} 以上にしてください。`);
      return;
    }
    setErr(null);
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      setErr("画像の読み込みを待ってからお試しください。");
      return;
    }
    const rect = img.getBoundingClientRect();
    const dW = rect.width;
    const dH = rect.height;
    const nW = img.naturalWidth;
    const nH = img.naturalHeight;
    const scaleX = nW / dW;
    const scaleY = nH / dH;
    const sx = box.left * scaleX;
    const sy = box.top * scaleY;
    const sw = box.w * scaleX;
    const sh = box.h * scaleY;
    const cropW = Math.max(1, Math.round(Math.min(sw, nW - sx)));
    const cropH = Math.max(1, Math.round(Math.min(sh, nH - sy)));
    const c = document.createElement("canvas");
    c.width = cropW;
    c.height = cropH;
    const cctx = c.getContext("2d");
    if (!cctx) {
      setErr("画像の切り出しに失敗しました。");
      return;
    }
    cctx.drawImage(img, Math.round(sx), Math.round(sy), cropW, cropH, 0, 0, cropW, cropH);
    c.toBlob(
      (blob) => {
        if (!blob) {
          setErr("切り出した画像の生成に失敗しました。");
          return;
        }
        onCroppedFile(new File([blob], "receipt-crop.jpg", { type: "image/jpeg" }));
        setDrag(null);
      },
      "image/jpeg",
      0.92,
    );
  }, [box, onCroppedFile]);

  const overlay = box
    ? (() => {
        const s: CSSProperties = {
          position: "absolute",
          left: box.left,
          top: box.top,
          width: box.w,
          height: box.h,
          border: "2px solid rgba(232, 93, 42, 0.9)",
          background: "color-mix(in srgb, rgba(232, 93, 42) 16%, transparent)",
          pointerEvents: "none" as const,
        };
        return s;
      })()
    : null;

  return (
    <div className={styles.receiptRescanBlock}>
      <p id={helpId} className={styles.receiptRescanHelp}>
        金額だけ違うとき：画像上で金額付近をドラッグで囲み、下の「この範囲で再解析」で
        再スキャンできます（全体再解析と同じくOCR最適化を適用します）。
      </p>
      <div
        className={styles.receiptRescanStage}
        role="group"
        aria-label="レシート。ドラッグで再解析する範囲を指定"
        aria-describedby={helpId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={busy ? { opacity: 0.5, pointerEvents: "none" } : undefined}
      >
        <img
          ref={imgRef}
          src={imageObjectUrl}
          alt="レシート拡大"
          className={styles.receiptRescanImage}
          draggable={false}
        />
        {overlay ? <div className={styles.receiptRescanBox} style={overlay} /> : null}
        {showResultOverlay ? (
          <div
            className={styles.receiptRescanResultOverlay}
            aria-live="polite"
            aria-label="解析結果プレビュー"
          >
            {ingestStatusMessage ? (
              <p className={styles.receiptRescanResultPending}>{ingestStatusMessage}</p>
            ) : !hasResultValues && parsingOcr ? (
              <p className={styles.receiptRescanResultPending}>AI 解析中…</p>
            ) : hasResultValues ? (
              <div>
                {displayDate ? (
                  <div className={styles.receiptRescanResultRow}>
                    <span className={styles.receiptRescanResultLabel} aria-hidden>
                      日付
                    </span>
                    <span className={styles.receiptRescanResultValue}>{displayDate}</span>
                  </div>
                ) : null}
                {displayTotal ? (
                  <div className={styles.receiptRescanResultRow}>
                    <span className={styles.receiptRescanResultLabel} aria-hidden>
                      金額
                    </span>
                    <span className={styles.receiptRescanResultValue}>{displayTotal}</span>
                  </div>
                ) : null}
                {memoRaw ? (
                  <div className={styles.receiptRescanResultRow}>
                    <span className={styles.receiptRescanResultLabel} aria-hidden>
                      メモ
                    </span>
                    <span className={`${styles.receiptRescanResultValue} ${styles.receiptRescanResultMemo}`}>
                      {memoRaw}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {err ? (
        <p className={styles.receiptRescanErr} role="alert">
          {err}
        </p>
      ) : null}
      <button
        type="button"
        className={styles.btn}
        disabled={!canSubmit}
        onClick={() => doCrop()}
        aria-disabled={!canSubmit}
      >
        この範囲で再解析
      </button>
    </div>
  );
}
