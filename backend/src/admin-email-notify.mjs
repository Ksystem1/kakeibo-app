/**
 * 管理者向けメール通知（Amazon SES）。
 * - 宛先: users.is_admin=1 かつ実メールの users.email、および ADMIN_NOTIFY_EXTRA_EMAILS（カンマ区切り）
 * - 送信元: SES_SOURCE_EMAIL（SES で検証済みの From 必須）
 * - 認証: デフォルトの AWS クレデンシャル（ECS タスクロール、ローカルはプロファイル等）
 */
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { createLogger } from "./logger.mjs";

const logger = createLogger("admin-email-notify");

const INTERNAL_EMAIL_RE = /@users\.kakeibo\.internal$/i;

function resolveSesRegion() {
  return (
    String(process.env.SES_REGION || process.env.AWS_REGION || "ap-northeast-1").trim() ||
    "ap-northeast-1"
  );
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @returns {Promise<string[]>}
 */
export async function collectAdminNotificationEmails(pool) {
  const [rows] = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(email)) AS em
     FROM users
     WHERE COALESCE(is_admin, 0) = 1
       AND email IS NOT NULL
       AND TRIM(email) <> ''
       AND LOWER(email) NOT LIKE '%@users.kakeibo.internal'`,
  );
  /** @type {Set<string>} */
  const set = new Set();
  const raw = process.env.ADMIN_NOTIFY_EXTRA_EMAILS;
  if (raw && String(raw).trim() !== "") {
    for (const p of String(raw).split(/[,;]+/)) {
      const t = p.trim().toLowerCase();
      if (t.includes("@") && !INTERNAL_EMAIL_RE.test(t)) set.add(t);
    }
  }
  for (const r of rows || []) {
    const e = r?.em != null ? String(r.em).trim().toLowerCase() : "";
    if (e && e.includes("@") && !INTERNAL_EMAIL_RE.test(e)) set.add(e);
  }
  return [...set].sort();
}

/**
 * @param {string} from
 * @param {string[]} to
 * @param {string} subject
 * @param {string} textBody
 */
export async function sendSesTextEmail({ from, to, subject, textBody }) {
  if (!to.length) {
    return { sent: false, reason: "no_recipients" };
  }
  const region = resolveSesRegion();
  const client = new SESClient({ region });
  const cmd = new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: to },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Text: { Data: textBody, Charset: "UTF-8" } },
    },
  });
  try {
    const res = await client.send(cmd);
    return { sent: true, messageId: res.MessageId ?? null, toCount: to.length };
  } catch (error) {
    // CloudWatch に必ず残したい詳細ログ
    console.error("SES Send Error:", error);
    throw error;
  }
}

/**
 * 管理者全員（＋追加分）にプレーンメール。FROM 未設定なら送らず { skipped, reason }。
 * @param {import("mysql2/promise").Pool} pool
 * @param {{ subject: string; textBody: string }} p
 */
export async function sendEmailToAdmins(pool, p) {
  if (String(process.env.ADMIN_NOTIFY_DISABLE || "").toLowerCase() === "1" || process.env.ADMIN_NOTIFY_DISABLE === "true") {
    return { sent: false, reason: "disabled_by_env" };
  }
  const from = String(
    process.env.SES_SOURCE_EMAIL || process.env.SES_FROM || process.env.ADMIN_EMAIL_FROM || "",
  ).trim();
  if (!from) {
    logger.warn("admin_email.skip_no_from", { hint: "SES_SOURCE_EMAIL を設定" });
    return { sent: false, reason: "no_ses_from" };
  }
  const to = await collectAdminNotificationEmails(pool);
  if (!to.length) {
    logger.warn("admin_email.skip_no_recipients", {});
    return { sent: false, reason: "no_recipient_emails" };
  }
  try {
    const r = await sendSesTextEmail({ from, to, subject: p.subject, textBody: p.textBody });
    logger.info("admin_email.sent", { toCount: r.toCount, messageId: r.messageId });
    return { sent: true, ...r };
  } catch (e) {
    logger.error("admin_email.send_failed", e, { toCount: to.length, from: from ? "(set)" : null });
    return { sent: false, reason: "ses_error", error: String(e?.message || e) };
  }
}

/**
 * @param {import("mysql2/promise").Pool} pool
 * @param {{ hasMismatches: boolean; reportJson: unknown; fix: boolean }} p
 */
export async function sendStripeReconcileAlertEmailIfNeeded(pool, p) {
  if (!p.hasMismatches) {
    return { sent: false, reason: "no_mismatches" };
  }
  if (String(process.env.STRIPE_RECONCILE_EMAIL || "1") === "0") {
    return { sent: false, reason: "disabled_stripe_reconcile_email" };
  }
  const subject = p.fix
    ? "[家計簿] Stripe と DB の不整合（同期バッチ: 修正を試みました）"
    : "[家計簿] Stripe と DB のサブスク状態の不整合を検出";
  const body = `このメールは stripe-subscription-reconcile ジョブから送られています。

時刻(UTC): ${new Date().toISOString()}
--fix 使用: ${p.fix ? "yes" : "no"}

詳細 (JSON):
${JSON.stringify(p.reportJson, null, 2)}

手順の参考:
- 一時的な不整合: npm run stripe:reconcile 実行（または GitHub / cron から同スクリプト）で再確認
- 継続する場合: --fix または Stripe / RDS の手動調査
`;
  return sendEmailToAdmins(pool, { subject, textBody: body });
}
