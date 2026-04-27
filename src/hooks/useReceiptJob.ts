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
  const firstSeenAtRef = useRef<Map<string, number>>(new Map());
  const timeoutNotifiedRef = useRef<Set<string>>(new Set());
  const progressStalledSinceRef = useRef<Map<string, number>>(new Map());
  const TIMEOUT_MS = 30_000;
  const STALL_RESCUE_MS = 5_000;

  useEffect(() => {
    const id = setInterval(() => {
      const pending = queueRef.current.filter(
        (x) => x.status === "pending" || x.status === "processing",
      );
      for (const q of pending) {
        const now = Date.now();
        const firstSeen = firstSeenAtRef.current.get(q.jobId) ?? now;
        if (!firstSeenAtRef.current.has(q.jobId)) {
          firstSeenAtRef.current.set(q.jobId, firstSeen);
        }
        const elapsed = now - firstSeen;
        const timedOut = elapsed >= TIMEOUT_MS;
        const estimatedBase = q.status === "pending" ? 30 : 90;
        const estimated = timedOut ? Math.min(97, 92 + Math.floor((elapsed - TIMEOUT_MS) / 5000)) : estimatedBase;
        if (timedOut && !timeoutNotifiedRef.current.has(q.jobId)) {
          timeoutNotifiedRef.current.add(q.jobId);
          setQueue((prev) =>
            prev.map((x) =>
              x.localKey === q.localKey
                ? {
                    ...x,
                    timeoutExceeded: true,
                    progressPct: Math.max(x.progressPct ?? 0, estimated),
                    errorMessage:
                      x.errorMessage ??
                      "30秒以上かかっています。自動で再試行中です。手動入力に切り替えることもできます。",
                  }
                : x,
            ),
          );
        }
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
            const badCompleted =
              st.status === "completed" &&
              st.result != null &&
              !isSuccessfulReceiptJobApplyResult(st.result);
            const rescueCompleted =
              st.status !== "completed" &&
              isSuccessfulReceiptJobApplyResult(st.result) &&
              Math.max(p.progressPct ?? 0, st.progress ?? 0, estimated) >= 95 &&
              now - (progressStalledSinceRef.current.get(q.jobId) ?? now) >= STALL_RESCUE_MS;
            const coerced: ReceiptAsyncJobStatus = badCompleted
              ? "failed"
              : rescueCompleted
                ? "completed"
                : st.status;
            const nextProgress =
              coerced === "completed"
                ? 100
                : coerced === "failed"
                  ? p.progressPct ?? estimated
                  : Math.max(p.progressPct ?? 0, estimated, st.progress ?? 0);
            const prevProgress = p.progressPct ?? 0;
            if (nextProgress > prevProgress) {
              progressStalledSinceRef.current.set(q.jobId, now);
            } else if (!progressStalledSinceRef.current.has(q.jobId)) {
              progressStalledSinceRef.current.set(q.jobId, now);
            }
            return prev.map((x) =>
              x.localKey === q.localKey
                ? {
                    ...x,
                    status: coerced,
                    progressPct: nextProgress,
                    timeoutExceeded: timedOut || x.timeoutExceeded === true,
                    result: st.result ?? x.result,
                    errorMessage: st.errorMessage ?? x.errorMessage ?? undefined,
                  }
                : x,
            );
          });
          if (st.status === "failed") {
            applyOncePerJobIdRef.current.delete(q.jobId);
            firstSeenAtRef.current.delete(q.jobId);
            progressStalledSinceRef.current.delete(q.jobId);
            return;
          }
          const stalledLong =
            progressStalledSinceRef.current.has(q.jobId) &&
            now - (progressStalledSinceRef.current.get(q.jobId) ?? now) >= STALL_RESCUE_MS;
          if (
            isSuccessfulReceiptJobApplyResult(st.result) &&
            (st.status === "completed" || stalledLong)
          ) {
            const completedResult: ParseReceiptResult = st.result;
            firstSeenAtRef.current.delete(q.jobId);
            timeoutNotifiedRef.current.delete(q.jobId);
            progressStalledSinceRef.current.delete(q.jobId);
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
