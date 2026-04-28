import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import {
  getReceiptJobStatus,
  type ParseReceiptResult,
  type ReceiptAsyncJobStatus,
  type ReceiptJobErrorPayload,
} from "../lib/api";
import { isSuccessfulReceiptJobApplyResult } from "../lib/receiptJobResult";

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
  result?: ParseReceiptResult | ReceiptJobErrorPayload;
  errorMessage?: string | null;
  progressPct?: number;
  timeoutExceeded?: boolean;
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
  const pollErrorCountRef = useRef<Map<string, number>>(new Map());
  const MAX_CONSECUTIVE_POLL_ERRORS = 5;

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
            if (typeof console !== "undefined" && console.log) {
              console.log("[receipt-job] polled status", {
                jobId: q.jobId,
                status: st.status,
                progress: st.progress ?? null,
                hasResult: st.result != null,
              });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const errCount = (pollErrorCountRef.current.get(q.jobId) ?? 0) + 1;
            pollErrorCountRef.current.set(q.jobId, errCount);
            if (errCount < MAX_CONSECUTIVE_POLL_ERRORS) {
              setQueue((prev) =>
                prev.map((x) =>
                  x.localKey === q.localKey
                    ? {
                        ...x,
                      timeoutExceeded: false,
                        errorMessage:
                          "解析状況の取得に一時的に失敗しています。自動再試行中です（手動入力へ切替可能）。",
                      }
                    : x,
                ),
              );
              return;
            }
            setQueue((prev) =>
              prev.map((x) =>
                x.localKey === q.localKey
                  ? {
                      ...x,
                      status: "failed",
                        timeoutExceeded: false,
                        errorMessage: "解析状況の取得に繰り返し失敗したため、手動入力をご利用ください。",
                      result: {
                        _schema: "receipt_job_v1",
                        error: "job_status_fetch_failed",
                        message: msg,
                      } as ReceiptJobErrorPayload,
                    }
                  : x,
              ),
            );
            pollErrorCountRef.current.delete(q.jobId);
            return;
          }
          pollErrorCountRef.current.delete(q.jobId);
          const hasResultNow = st.result != null;
          if (hasResultNow && st.status !== "completed" && st.status !== "failed") {
            st = { ...st, status: "completed", progress: 100 };
          }
          setQueue((prev) => {
            const p = prev.find((x) => x.localKey === q.localKey);
            if (!p) return prev;
            const coerced: ReceiptAsyncJobStatus = st.status;
            const nextProgress =
              coerced === "completed"
                ? 100
                : coerced === "failed"
                  ? p.progressPct ?? 0
                  : Math.max(p.progressPct ?? 0, st.progress ?? 0, 0);
            return prev.map((x) =>
              x.localKey === q.localKey
                ? {
                    ...x,
                    status: coerced,
                    progressPct: nextProgress,
                    timeoutExceeded: false,
                    result: st.result ?? x.result,
                    errorMessage: st.errorMessage ?? x.errorMessage ?? undefined,
                  }
                : x,
            );
          });
          if (st.status === "failed") {
            applyOncePerJobIdRef.current.delete(q.jobId);
            pollErrorCountRef.current.delete(q.jobId);
            return;
          }
          if (
            isSuccessfulReceiptJobApplyResult(st.result) &&
            st.status === "completed"
          ) {
            const completedResult: ParseReceiptResult = st.result;
            pollErrorCountRef.current.delete(q.jobId);
            if (!applyOncePerJobIdRef.current.has(q.jobId)) {
              applyOncePerJobIdRef.current.add(q.jobId);
              if (q.objectUrl === previewRef.current) {
                onApplyResultRef.current(completedResult);
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
