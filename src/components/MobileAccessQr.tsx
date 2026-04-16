import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import QRCode from "react-qr-code";

/**
 * スマホが開くべき画面のオリジン。
 * localhost のまま QR にすると、スマホ側の「localhost」＝端末自身を指し接続できず固まったように見える。
 */
function getMobileQrOrigin(): string | null {
  const fromEnv = import.meta.env.VITE_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (typeof window === "undefined") return null;
  const h = window.location.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "::1"
  ) {
    return null;
  }
  return window.location.origin;
}

/** Vite の base（例: /kakeibo/）と React Router の pathname（basename なし）を結合する */
function fullAppPath(pathname: string) {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${base}${pathname}`;
}

function buildQrUrl(pathname: string, search: string, fixedPath?: string) {
  const origin = getMobileQrOrigin();
  if (!origin) return "";

  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

  if (fixedPath) {
    if (fixedPath.startsWith("http")) return fixedPath;
    const pathStr = fixedPath.startsWith("/")
      ? fixedPath
      : `${base}/${fixedPath.replace(/^\//, "")}`;
    return new URL(pathStr, origin).toString();
  }

  const pathWithQuery = `${fullAppPath(pathname)}${search}`;
  return new URL(pathWithQuery, origin).toString();
}

/**
 * 同一 Wi‑Fi のスマホで画面 URL を開くための QR。
 * RR の pathname は basename を含まないため、origin との単純結合では /kakeibo/ が欠ける。
 */
export function MobileAccessQr({
  fixedPath,
  compact = false,
}: {
  fixedPath?: string;
  compact?: boolean;
}) {
  const { pathname, search } = useLocation();
  const effectiveFixedPath = fixedPath ?? `${import.meta.env.BASE_URL}login`;
  const value = useMemo(
    () =>
      typeof window === "undefined" ? "" : buildQrUrl(pathname, search, effectiveFixedPath),
    [pathname, search, effectiveFixedPath],
  );

  const originOk = getMobileQrOrigin() !== null;

  if (!originOk) {
    return (
      <div
        style={{
          maxWidth: 220,
          padding: "8px 10px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "rgba(255,255,255,0.04)",
          fontSize: "0.68rem",
          lineHeight: 1.45,
          color: "var(--text-muted)",
        }}
      >
        <strong style={{ color: "var(--text)", display: "block", marginBottom: 4 }}>
          スマホ用 QR を出せません
        </strong>
        ブラウザが <code style={{ fontSize: "0.65rem" }}>localhost</code>{" "}
        のとき、QR に載せてもスマホは PC に届きません。
        <br />
        <br />
        対処: PC を{" "}
        <strong style={{ color: "var(--text)" }}>LAN の IP</strong>（例{" "}
        <code style={{ fontSize: "0.65rem" }}>http://192.168.x.x:5173</code>
        ）で開くか、.env に{" "}
        <code style={{ fontSize: "0.65rem" }}>VITE_PUBLIC_ORIGIN</code>{" "}
        を設定してフロントを再起動してください。
        <br />
        <br />
        併せて <code style={{ fontSize: "0.65rem" }}>VITE_API_URL</code>{" "}
        もスマホから届く URL（同じ LAN IP）にしてください。
      </div>
    );
  }

  if (!value) return null;

  return (
    <div
      title={value}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: compact ? 4 : 6,
        padding: compact ? "6px 8px" : "8px 10px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "rgba(255,255,255,0.04)",
      }}
    >
      <span
        style={{
          fontSize: compact ? "0.68rem" : "0.74rem",
          color: "var(--text-muted)",
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        スマホで開く
      </span>
      <div
        style={{
          padding: compact ? 6 : 10,
          borderRadius: 8,
          background: "#fff",
          lineHeight: 0,
          border: "1px solid #dbe3ea",
        }}
      >
        <QRCode
          value={value}
          size={compact ? 88 : 156}
          level="Q"
          fgColor="#0f1419"
          bgColor="#ffffff"
        />
      </div>
      {!compact ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: "0.7rem", color: "var(--accent)", textDecoration: "none" }}
        >
          読み取れない場合はURLを開く
        </a>
      ) : null}
    </div>
  );
}
