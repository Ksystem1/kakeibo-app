import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createTransaction, getCategories, parseReceiptImage } from "../lib/api";
import { useReceiptTouchUi } from "../hooks/useReceiptTouchUi";
import styles from "../components/KakeiboDashboard.module.css";

/** 日付入力（type=date）に載せられる形へ寄せる。無理ならテキストとして扱う */
function dateFieldMode(raw: string): { kind: "iso"; value: string } | { kind: "text"; value: string } {
  const s = raw.trim();
  if (!s) return { kind: "iso", value: "" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "iso", value: s };
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s);
  if (m) {
    return {
      kind: "iso",
      value: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`,
    };
  }
  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (jp) {
    return {
      kind: "iso",
      value: `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`,
    };
  }
  return { kind: "text", value: s };
}

type ExpenseCategory = { id: number; name: string; kind: "expense" | "income" };

const CATEGORY_TAGS = {
  food: ["食費", "食品", "食料品", "飲食", "スーパー", "グロサリー", "grocery", "food"],
  daily: ["日用品", "雑貨", "生活用品", "ドラッグ", "ドラッグストア"],
  transport: ["交通", "交通費", "電車", "バス", "タクシー", "ガソリン", "駐車場"],
  utility: ["水道", "光熱費", "電気", "ガス", "通信", "ネット", "携帯"],
  medical: ["医療", "病院", "薬", "薬局", "ドラッグ"],
  leisure: ["娯楽", "交際", "外食", "趣味", "レジャー"],
} as const;

const TAG_KEYWORDS = {
  food: [
    "りんご",
    "バナナ",
    "野菜",
    "肉",
    "魚",
    "牛乳",
    "卵",
    "パン",
    "米",
    "弁当",
    "飲料",
    "ジュース",
    "スーパー",
    "コンビニ",
  ],
  daily: ["ティッシュ", "洗剤", "シャンプー", "歯ブラシ", "トイレットペーパー", "日用品"],
  transport: ["電車", "バス", "タクシー", "駐車", "ガソリン", "高速", "ic"],
  utility: ["電気", "ガス", "水道", "通信", "wifi", "インターネット", "携帯"],
  medical: ["薬", "病院", "診療", "処方", "クリニック"],
  leisure: ["映画", "カフェ", "外食", "レジャー", "趣味", "書籍"],
} as const;

function normalizeJa(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[　]/g, "");
}

function tagFromCategoryName(name: string): keyof typeof CATEGORY_TAGS | null {
  const n = normalizeJa(name);
  for (const [tag, aliases] of Object.entries(CATEGORY_TAGS) as Array<
    [keyof typeof CATEGORY_TAGS, readonly string[]]
  >) {
    if (aliases.some((a) => n.includes(normalizeJa(a)))) return tag;
  }
  return null;
}

function suggestExpenseCategoryId(
  categories: ExpenseCategory[],
  vendor: string,
  items: Array<{ name: string; amount: number | null; confidence?: number }>,
): number | null {
  if (categories.length === 0) return null;
  const corpus = normalizeJa(`${vendor} ${items.map((x) => x.name).join(" ")}`);
  if (!corpus) return null;
  const tagScore: Record<string, number> = {};
  for (const [tag, words] of Object.entries(TAG_KEYWORDS)) {
    const score = words.reduce(
      (acc, w) => (corpus.includes(normalizeJa(w)) ? acc + 1 : acc),
      0,
    );
    if (score > 0) tagScore[tag] = score;
  }
  const ranked = categories
    .map((c) => {
      const tag = tagFromCategoryName(c.name);
      return {
        id: c.id,
        score: tag ? (tagScore[tag] ?? 0) : 0,
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score <= 0) return null;
  return ranked[0].id;
}

export function ReceiptPage() {
  const touchUi = useReceiptTouchUi();
  const cameraInputId = useId();
  const galleryInputId = useId();
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraHint, setCameraHint] = useState<string | null>(null);
  const vendorFieldId = useId();
  const totalFieldId = useId();
  const dateFieldId = useId();

  const navigate = useNavigate();

  const [notice, setNotice] = useState<string | null>(null);
  /** 解析結果を反映したうえでユーザーが修正可能 */
  const [draftVendor, setDraftVendor] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [items, setItems] = useState<
    Array<{ name: string; amount: number | null; confidence?: number }>
  >([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(null);
  const [categorySuggestSource, setCategorySuggestSource] = useState<
    "history" | "keywords" | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const r = await getCategories();
        const mapped = (r.items as Array<Record<string, unknown>>)
          .map((c) => ({
            id: Number(c.id),
            name: String(c.name ?? ""),
            kind: String(c.kind ?? "expense") as "expense" | "income",
          }))
          .filter((c) => Number.isFinite(c.id) && c.name && c.kind === "expense");
        if (!mounted) return;
        setCategories(mapped);
      } catch {
        if (!mounted) return;
        setCategories([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (draftCategoryId != null) return;
    if (!draftVendor && items.length === 0) return;
    const suggested = suggestExpenseCategoryId(categories, draftVendor, items);
    if (suggested != null) setDraftCategoryId(suggested);
  }, [categories, draftVendor, items, draftCategoryId]);

  useEffect(() => {
    if (!touchUi || !loading) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [touchUi, loading]);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));
    if (typeof window !== "undefined") {
      const standaloneByMedia = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
      const standaloneByNavigator = Boolean(
        (window.navigator as Navigator & { standalone?: boolean }).standalone,
      );
      setIsStandalone(standaloneByMedia || standaloneByNavigator);
    }
  }, []);

  useEffect(() => {
    if (!isIOS) return;
    if (isStandalone) {
      setNotice(
        "iPhone のホーム画面アプリではカメラが黒画面になる場合があります。Safari で開くか、写真アプリで撮影後に「ファイルを選ぶ」から選択してください。",
      );
    }
  }, [isIOS, isStandalone]);

  useEffect(() => {
    return () => {
      const s = cameraStreamRef.current;
      if (!s) return;
      s.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    };
  }, []);

  async function attachStreamToVideo(stream: MediaStream): Promise<boolean> {
    const v = cameraVideoRef.current;
    if (!v) return false;
    v.srcObject = stream;
    try {
      await v.play();
    } catch {
      // ignore
    }
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        v.onloadeddata = null;
        v.onloadedmetadata = null;
        resolve(ok);
      };
      const timer = globalThis.setTimeout(() => {
        globalThis.clearTimeout(timer);
        finish(v.videoWidth > 0 && v.videoHeight > 0);
      }, 1800);
      v.onloadedmetadata = () => finish(v.videoWidth > 0 && v.videoHeight > 0);
      v.onloadeddata = () => finish(v.videoWidth > 0 && v.videoHeight > 0);
    });
  }

  async function openCamera() {
    if (cameraBusy || loading) return;
    // iOS (iPhone 16 含む) は getUserMedia で黒画面化する事例があるため、
    // カメラ起動経路は使わずライブラリ選択へ誘導する。
    if (isIOS) {
      galleryInputRef.current?.click();
      return;
    }
    setCameraBusy(true);
    setNotice(null);
    setCameraHint(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("このブラウザはカメラAPIに対応していません。");
      }
      setCameraOpen(true);
      const candidates: MediaStreamConstraints[] = [
        {
          video: {
            facingMode: { exact: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        },
        {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        },
        { video: { facingMode: "user" }, audio: false },
        { video: true, audio: false },
      ];
      let stream: MediaStream | null = null;
      for (let i = 0; i < candidates.length; i += 1) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(candidates[i]);
          const ok = await attachStreamToVideo(stream);
          if (ok) {
            cameraStreamRef.current = stream;
            if (i > 0) {
              setCameraHint("別カメラ設定で起動しました。黒画面時はそのまま撮影をお試しください。");
            }
            break;
          }
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
        } catch {
          stream = null;
        }
      }
      if (!stream) {
        throw new Error("カメラ映像を取得できませんでした。ブラウザのカメラ権限をご確認ください。");
      }
    } catch (e) {
      setCameraOpen(false);
      setNotice(e instanceof Error ? `カメラ起動に失敗: ${e.message}` : "カメラ起動に失敗しました。");
    } finally {
      setCameraBusy(false);
    }
  }

  function closeCamera() {
    const s = cameraStreamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    const v = cameraVideoRef.current;
    if (v) v.srcObject = null;
    setCameraOpen(false);
  }

  async function capturePhoto() {
    const v = cameraVideoRef.current;
    if (!v || v.videoWidth <= 0 || v.videoHeight <= 0) {
      setNotice("カメラ映像を取得できませんでした。");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setNotice("画像生成に失敗しました。");
      return;
    }
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    if (!blob) {
      setNotice("撮影画像の生成に失敗しました。");
      return;
    }
    closeCamera();
    const file = new File([blob], `receipt-${Date.now()}.jpg`, { type: "image/jpeg" });
    await onFile(file);
  }

  async function onFile(f: File | null) {
    if (!f) return;
    setLoading(true);
    setNotice(null);
    setDraftVendor("");
    setDraftTotal("");
    setDraftDate("");
    setDraftCategoryId(null);
    setCategorySuggestSource(null);
    setItems([]);
    try {
      const buf = await f.arrayBuffer();
      const b64 = btoa(
        new Uint8Array(buf).reduce((s, x) => s + String.fromCharCode(x), ""),
      );
      const r = await parseReceiptImage(b64);
      setItems(r.items ?? []);
      const s = r.summary;
      setDraftVendor(s?.vendorName?.trim() ?? "");
      setDraftTotal(
        s?.totalAmount != null && Number.isFinite(Number(s.totalAmount))
          ? String(s.totalAmount)
          : "",
      );
      {
        const raw = s?.date?.trim() ?? "";
        const dm = dateFieldMode(raw);
        setDraftDate(dm.kind === "iso" ? dm.value : raw);
      }
      const localSuggested = suggestExpenseCategoryId(
        categories,
        s?.vendorName?.trim() ?? "",
        r.items ?? [],
      );
      setDraftCategoryId(r.suggestedCategoryId ?? localSuggested);
      setCategorySuggestSource(
        r.suggestedCategorySource ??
          (r.suggestedCategoryId == null && localSuggested != null ? "keywords" : null),
      );
      setNotice(r.notice ?? null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    void onFile(e.target.files?.[0] ?? null);
    e.target.value = "";
  }

  const pickDisabled = loading ? styles.receiptPickBtnDisabled : "";

  const dateField = useMemo(() => dateFieldMode(draftDate), [draftDate]);

  const loadingUi = (
    <>
      {touchUi ? (
        <div
          className={styles.receiptLoadingOverlay}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className={styles.receiptLoadingOverlayInner}>
            <span className={styles.receiptSpinner} aria-hidden />
            <p className={styles.receiptLoadingOverlayText}>解析中...</p>
          </div>
        </div>
      ) : (
        <div
          className={styles.receiptLoadingPanel}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className={styles.receiptSpinner} aria-hidden />
          <span>解析中...</span>
        </div>
      )}
    </>
  );

  return (
    <div className={styles.wrap}>
      {loading ? loadingUi : null}
      <h1 className={styles.title}>レシート読取</h1>

      <p className={styles.sub}>
        レシート画像を選択すると、店舗名・合計金額・日付を自動入力します。
        明細ごとの金額表示は行わず、合計金額を優先して読み取ります。
      </p>
      {touchUi ? (
        <div className={styles.receiptPickRow}>
          <input
            ref={cameraInputRef}
            id={cameraInputId}
            type="file"
            accept="image/*"
            className="visually-hidden"
            disabled={loading}
            onChange={handleFileChange}
          />
          <input
            ref={galleryInputRef}
            id={galleryInputId}
            type="file"
            accept="image/*"
            className="visually-hidden"
            disabled={loading}
            onChange={handleFileChange}
          />
          {!isIOS ? (
            <button
              type="button"
              className={`${styles.receiptPickBtn} ${styles.btnPrimary} ${pickDisabled}`}
              onClick={openCamera}
              disabled={loading || cameraBusy}
            >
              {cameraBusy ? "カメラ起動中…" : "写真を撮る"}
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.receiptPickBtn} ${pickDisabled}`}
            onClick={() => galleryInputRef.current?.click()}
            disabled={loading}
          >
            {isIOS ? "写真を選ぶ" : "ファイルを選ぶ"}
          </button>
        </div>
      ) : (
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          disabled={loading}
          style={{ marginBottom: "1rem" }}
        />
      )}
      {cameraOpen ? (
        <div className={styles.receiptLoadingOverlay}>
          <div className={styles.receiptLoadingOverlayInner}>
            <video
              ref={cameraVideoRef}
              autoPlay
              playsInline
              muted
              style={{ width: "min(92vw, 520px)", borderRadius: 10, background: "#000" }}
            />
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  void capturePhoto();
                }}
              >
                撮影して読み込む
              </button>
              <button type="button" className={styles.btn} onClick={closeCamera}>
                キャンセル
              </button>
            </div>
            {cameraHint ? (
              <p className={styles.receiptSummaryHint} style={{ margin: 0 }}>
                {cameraHint}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <form
        className={styles.receiptSummaryForm}
        onSubmit={(e) => e.preventDefault()}
      >
        <p className={styles.receiptSummaryHint}>
          {touchUi
            ? "内容確認"
            : "解析後、店舗名・合計・日付が下記に自動入力されます。内容はいつでも手で修正できます。"}
        </p>
        <div className={styles.field}>
          <label htmlFor={vendorFieldId}>店舗名</label>
          <input
            id={vendorFieldId}
            type="text"
            autoComplete="organization"
            placeholder="例: 〇〇ストア"
            value={draftVendor}
            onChange={(e) => setDraftVendor(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={totalFieldId}>合計金額（円）</label>
          <input
            id={totalFieldId}
            type="text"
            inputMode="decimal"
            placeholder="例: 1234"
            value={draftTotal}
            onChange={(e) => setDraftTotal(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={dateFieldId}>日付</label>
          {dateField.kind === "iso" ? (
            <input
              id={dateFieldId}
              type="date"
              value={dateField.value}
              onChange={(e) => setDraftDate(e.target.value)}
              disabled={loading}
            />
          ) : (
            <input
              id={dateFieldId}
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD など"
              value={dateField.value}
              onChange={(e) => setDraftDate(e.target.value)}
              disabled={loading}
            />
          )}
        </div>
        <div className={styles.field}>
          <label>カテゴリ</label>
          <select
            value={draftCategoryId ?? ""}
            onChange={(e) =>
              setDraftCategoryId(e.target.value ? Number(e.target.value) : null)
            }
            disabled={loading}
          >
            <option value="">未分類</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {draftCategoryId != null && categorySuggestSource ? (
            <small className={styles.receiptSummaryHint}>
              {categorySuggestSource === "history"
                ? "過去の登録履歴から自動分類しました。必要なら変更できます。"
                : "レシート内容（店舗名・品目）から自動分類しました。必要なら変更できます。"}
            </small>
          ) : null}
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={
            loading ||
            registering ||
            !draftTotal.trim() ||
            dateField.kind !== "iso"
          }
          onClick={async () => {
            if (registering) return;
            setNotice(null);

            const amount = Number.parseFloat(draftTotal);
            if (!Number.isFinite(amount) || amount <= 0) {
              setNotice("金額を正しい数値で入力してください。");
              return;
            }
            if (dateField.kind !== "iso") {
              setNotice("日付は YYYY-MM-DD 形式にしてください。");
              return;
            }

            setRegistering(true);
            try {
              await createTransaction({
                kind: "expense",
                amount,
                transaction_date: dateField.value,
                memo: draftVendor.trim() || null,
                category_id: draftCategoryId,
              });
              const month = dateField.value.slice(0, 7);
              navigate(`/?month=${encodeURIComponent(month)}`, { replace: true });
            } catch (e) {
              setNotice(e instanceof Error ? e.message : String(e));
            } finally {
              setRegistering(false);
            }
          }}
        >
          {registering ? "登録中…" : "登録"}
        </button>
      </form>

      {notice ? (
        <p className={styles.infoText} style={{ marginBottom: "1rem" }}>
          {notice}
        </p>
      ) : null}

      {!touchUi && items.length === 0 ? (
        <p className={styles.sub}>画像を選択すると、合計金額を自動で反映します。</p>
      ) : null}
    </div>
  );
}
