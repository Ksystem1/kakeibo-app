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
  const processingSeenAtRef = useRef<Map<string, number>>(new Map());
  const pollErrorCountRef = useRef<Map<string, number>>(new Map());
  const timeoutNotifiedRef = useRef<Set<string>>(new Set());
  const progressStalledSinceRef = useRef<Map<string, number>>(new Map());
  const TIMEOUT_MS = 30_000;
  const STALL_RESCUE_MS = 10_000;
  const MAX_CONSECUTIVE_POLL_ERRORS = 5;

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
        const processingSeen =
          q.status === "processing"
            ? (processingSeenAtRef.current.get(q.jobId) ?? now)
            : now;
        if (q.status === "processing" && !processingSeenAtRef.current.has(q.jobId)) {
          processingSeenAtRef.current.set(q.jobId, processingSeen);
        }
        if (q.status !== "processing") {
          processingSeenAtRef.current.delete(q.jobId);
        }
        const elapsed = now - firstSeen;
        const timedOut = q.status === "processing" && now - processingSeen >= TIMEOUT_MS;
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
                    progressPct: Math.max(x.progressPct ?? 0, 97),
                  }
                : x,
            ),
          );
        }
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
                        timeoutExceeded: true,
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
                      timeoutExceeded: true,
                      errorMessage:
                        "解析状況の取得に繰り返し失敗したため、手動入力をご利用ください。",
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
            progressStalledSinceRef.current.delete(q.jobId);
            return;
          }
          pollErrorCountRef.current.delete(q.jobId);
          const hasResultNow = st.result != null;
          if (hasResultNow && st.status !== "completed" && st.status !== "failed") {
            st = { ...st, status: "completed", progress: 100 };
          }
          const hardTimedOut =
            q.status === "processing" &&
            processingSeenAtRef.current.has(q.jobId) &&
            now - (processingSeenAtRef.current.get(q.jobId) ?? now) >= TIMEOUT_MS;
          if (hardTimedOut && st.status !== "completed") {
            setQueue((prev) =>
              prev.map((x) =>
                x.localKey === q.localKey
                  ? {
                      ...x,
                      status: "failed",
                      timeoutExceeded: true,
                      errorMessage:
                        "解析がタイムアウトしました。手動入力へ切り替えてください。",
                      result: {
                        _schema: "receipt_job_v1",
                        error: "job_processing_timeout",
                        message: "processing が20秒継続したためタイムアウトしました。",
                      } as ReceiptJobErrorPayload,
                    }
                  : x,
              ),
            );
            applyOncePerJobIdRef.current.delete(q.jobId);
            firstSeenAtRef.current.delete(q.jobId);
            processingSeenAtRef.current.delete(q.jobId);
            pollErrorCountRef.current.delete(q.jobId);
            timeoutNotifiedRef.current.delete(q.jobId);
            progressStalledSinceRef.current.delete(q.jobId);
            return;
          }
          const stalledLongBefore =
            progressStalledSinceRef.current.has(q.jobId) &&
            now - (progressStalledSinceRef.current.get(q.jobId) ?? now) >= STALL_RESCUE_MS &&
            Math.max(q.progressPct ?? 0, st.progress ?? 0, estimated) >= 90;
          if (stalledLongBefore && st.status !== "completed") {
            try {
              const forced = await getReceiptJobStatus(q.jobId);
              if (
                forced.status === "completed" ||
                (forced.result != null && isSuccessfulReceiptJobApplyResult(forced.result))
              ) {
                st = forced;
              }
            } catch {
              /* keep previous status */
            }
          }
          setQueue((prev) => {
            const p = prev.find((x) => x.localKey === q.localKey);
            if (!p) return prev;
            const rescueCompleted =
              st.status !== "completed" &&
              isSuccessfulReceiptJobApplyResult(st.result) &&
              Math.max(p.progressPct ?? 0, st.progress ?? 0, estimated) >= 90 &&
              now - (progressStalledSinceRef.current.get(q.jobId) ?? now) >= STALL_RESCUE_MS;
            const coerced: ReceiptAsyncJobStatus = rescueCompleted
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
                    timeoutExceeded:
                      coerced === "pending" || coerced === "processing"
                        ? timedOut || x.timeoutExceeded === true
                        : false,
                    result: st.result ?? x.result,
                    errorMessage: st.errorMessage ?? x.errorMessage ?? undefined,
                  }
                : x,
            );
          });
          if (st.status === "failed") {
            applyOncePerJobIdRef.current.delete(q.jobId);
            firstSeenAtRef.current.delete(q.jobId);
            processingSeenAtRef.current.delete(q.jobId);
            pollErrorCountRef.current.delete(q.jobId);
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
            processingSeenAtRef.current.delete(q.jobId);
            pollErrorCountRef.current.delete(q.jobId);
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
