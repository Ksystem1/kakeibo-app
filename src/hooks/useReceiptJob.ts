import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import {
  getReceiptJobStatus,
  type ParseReceiptResult,
  type ReceiptAsyncJobStatus,
} from "../lib/api";

const DEFAULT_POLL_MS = 1600;

/**
 * `POST /receipts/upload` 後、job_id 単位で `GET /receipts/job-status/:id` をポーリングし
 * キュー行の status / result / errorMessage を更新する。完了かつプレビューと URL が一致すれば onApplyResult を1回だけ呼ぶ。
 */
export type ReceiptImportQueueItem = {
  localKey: string;
  fileName: string;
  objectUrl: string;
  jobId: string;
  status: ReceiptAsyncJobStatus;
  result?: ParseReceiptResult;
  errorMessage?: string | null;
};

export function useReceiptJob(
  queue: ReceiptImportQueueItem[],
  setQueue: Dispatch<SetStateAction<ReceiptImportQueueItem[]>>,
  previewObjectUrl: string | null,
  onApplyResult: (r: ParseReceiptResult) => void,
  options?: { pollIntervalMs?: number },
) {
  const queueRef = useRef(queue);
  const previewRef = useRef(previewObjectUrl);
  const applyOncePerJobIdRef = useRef<Set<string>>(new Set());
  const onApplyResultRef = useRef(onApplyResult);
  onApplyResultRef.current = onApplyResult;

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    previewRef.current = previewObjectUrl;
  }, [previewObjectUrl]);

  const intervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_MS;

  useEffect(() => {
    const id = setInterval(() => {
      const pending = queueRef.current.filter(
        (x) => x.status === "pending" || x.status === "processing",
      );
      for (const q of pending) {
        void (async () => {
          let st: Awaited<ReturnType<typeof getReceiptJobStatus>>;
          try {
            st = await getReceiptJobStatus(q.jobId);
          } catch {
            return;
          }
          setQueue((prev) => {
            const p = prev.find((x) => x.localKey === q.localKey);
            if (!p) return prev;
            return prev.map((x) =>
              x.localKey === q.localKey
                ? {
                    ...x,
                    status: st.status,
                    result: st.result ?? x.result,
                    errorMessage: st.errorMessage ?? undefined,
                  }
                : x,
            );
          });
          if (st.status === "failed") {
            applyOncePerJobIdRef.current.delete(q.jobId);
            return;
          }
          if (st.status === "completed" && st.result) {
            if (!applyOncePerJobIdRef.current.has(q.jobId)) {
              applyOncePerJobIdRef.current.add(q.jobId);
              if (q.objectUrl === previewRef.current) {
                onApplyResultRef.current(st.result);
              }
              if (
                typeof document !== "undefined" &&
                document.visibilityState === "hidden" &&
                typeof Notification !== "undefined" &&
                Notification.permission === "granted"
              ) {
                try {
                  new Notification("レシートの解析が完了しました", {
                    body: "取込内容をご確認ください。",
                  });
                } catch {
                  /* ignore */
                }
              }
            }
          }
        })();
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [setQueue, intervalMs]);
}
