import { useState } from "react";
import { Link } from "react-router-dom";
import styles from "../components/KakeiboDashboard.module.css";

/**
 * Stripe 審査・利用者向け：データ取り込み方針、特商法備考、利用規約（個人情報）、FAQ。
 * 認証不要で閲覧可能。
 */
type LegalTabId = "tokusho" | "terms" | "privacy" | "faq";

const TABS: Array<{ id: LegalTabId; label: string }> = [
  { id: "tokusho", label: "特商法" },
  { id: "terms", label: "利用規約" },
  { id: "privacy", label: "個人情報" },
  { id: "faq", label: "よくある質問" },
];

export function LegalInfoPage() {
  const [activeTab, setActiveTab] = useState<LegalTabId>("tokusho");

  const tabBtnStyle = (active: boolean) =>
    ({
      border: "1px solid var(--border)",
      background: active ? "var(--accent-dim)" : "var(--bg-card)",
      color: "var(--text)",
      borderRadius: 8,
      cursor: "pointer",
      font: "inherit",
      fontWeight: active ? 700 : 600,
      padding: "0.42rem 0.72rem",
      minHeight: 44,
      lineHeight: 1.2,
    }) as const;

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <h1 className={styles.title}>特商法の表記・利用規約・よくある質問</h1>
        <p className={styles.sub}>
          家計簿データの取り込み方法の概要です。金融機関等のログイン情報の取得・保持は行いません。
        </p>
        <p className={styles.sub} style={{ marginTop: "0.5rem" }}>
          <Link to="/login" style={{ color: "var(--accent)" }}>ログイン</Link>{" "}
          ／ <Link to="/" style={{ color: "var(--accent)" }}>ホーム</Link>
        </p>
      </header>

      <nav
        className={styles.settingsPanel}
        style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}
        aria-label="法的情報タブ"
      >
        <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              style={tabBtnStyle(activeTab === tab.id)}
              onClick={() => setActiveTab(tab.id)}
              aria-selected={activeTab === tab.id}
              role="tab"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {activeTab === "tokusho" ? (
      <section id="tokusho" className={styles.settingsPanel} style={{ marginBottom: "1rem" }}>
        <h2 className={styles.title} style={{ marginTop: 0, fontSize: "clamp(1.15rem, 3.5vw, 1.4rem)" }}>
          特定商取引法に基づく表記
        </h2>
        <div style={{ overflowX: "auto", margin: "0.55rem 0 0.85rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <tbody>
              {[
                ["販売価格", "各プランのページに表示"],
                ["代金の支払時期", "クレジットカード決済時、または毎月更新時"],
                ["商品の引渡時期", "決済完了後、即時利用可能"],
                ["返品・キャンセル", "デジタルコンテンツの特性上、返品・返金は不可。解約はいつでも設定画面から可能"],
                [
                  "販売事業者名・連絡先",
                  "〒101-0024 東京都千代田区神田和泉町1番地6-16ヤマトビル405 / バーチャルオフィス（秋葉原） / script00123+gmo@gmail.com / 電話：048-400-2253",
                ],
              ].map(([k, v]) => (
                <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
                  <th
                    style={{
                      textAlign: "left",
                      verticalAlign: "top",
                      whiteSpace: "nowrap",
                      width: "13rem",
                      padding: "0.52rem 0.65rem",
                      background: "var(--bg-card)",
                    }}
                  >
                    {k}
                  </th>
                  <td style={{ padding: "0.52rem 0.65rem", lineHeight: 1.6 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.sub} style={{ margin: "0.4rem 0", lineHeight: 1.6 }}>
          事業者名、所在地、連絡先、販売価格、支払条件、解約条件等、法令及び所管庁のガイドラインに従い必要事項を示します。具体的な
          記載箇所は、本アプリ内の料金・お支払い、または本サービスのお問い合わせ先に従います。以下の「備考」は
          データ取り込みの仕様を補足するための表記です。
        </p>
        <h3
          className={styles.receiptFormBanner}
          id="tokusho-bikou"
          style={{ fontSize: "0.95rem", margin: "0.9rem 0 0.5rem" }}
        >
          備考（取り込みデータの仕様）
        </h3>
        <ul style={{ lineHeight: 1.75, maxWidth: "50rem", margin: 0, paddingLeft: "1.2rem" }}>
          <li style={{ marginBottom: "0.65rem" }}>
            本サービスは、<strong>銀行口座等との接続</strong>による
            取引明細の<strong>自動取得</strong>、金融機関等のウェブ上に当社が代わりに接続（ログイン）し
            明細等を収集する行為（<strong>スクレイピング</strong> 等）を
            <strong>行いません</strong>。
          </li>
          <li style={{ marginBottom: "0.65rem" }}>
            電子マネー等（<strong>PayPay</strong> 等）の明細取り込みは、
            利用者が各事業者が定める手順に従い<strong>書き出した CSV 等</strong>を
            本サービス所定の画面に<strong>任意</strong>にアップロードする、または
            同趣旨の内容を所定欄に貼り付ける形に限ります。当社が利用者の
            <strong>銀行等の利用者向け ID・パスワード等を保持することは一切ありません</strong>。
          </li>
        </ul>
      </section>
      ) : null}

      {activeTab === "terms" ? (
      <section id="terms" className={styles.settingsPanel} style={{ marginBottom: "1rem" }}>
        <h2 className={styles.title} style={{ marginTop: 0, fontSize: "clamp(1.15rem, 3.5vw, 1.4rem)" }}>利用規約（抜粋）</h2>
        <p className={styles.sub} style={{ lineHeight: 1.65, margin: "0.35rem 0" }}>
          本サービスを利用する前に、本規約をお読みください。全文は、必要に応じ、お問い合わせ等で
          別途定める事項含めお求め可能な範囲で定めるものとし、下記の「個人情報の取扱い」等は
          利用時の方針を示すための抜粋です。
        </p>
        <h3
          className={styles.receiptFormBanner}
          id="privacy"
          style={{ fontSize: "0.95rem", margin: "0.85rem 0 0.45rem" }}
        >
          個人情報の取扱い（抜粋・利用規約上の方針）
        </h3>
        <p className={styles.sub} id="terms-privacy" style={{ lineHeight: 1.75, margin: "0.3rem 0" }}>
          <strong>第7条（個人情報等の取扱い）【抜粋】</strong>
        </p>
        <p className={styles.sub} style={{ lineHeight: 1.75, margin: "0.35rem 0" }}>
          当社は、氏名、メールアドレス、本サービス上で登録・入力された家計データ、および利用者の操作により
          当社のサーバへ送信されたファイルの内容等を、本サービス提供、本人確認、不具合対応、
          法令の遵守、および利用者案内（メール等）の目的の範囲で取り扱います。なお、当社は
          金融機関等、資金送金又は前払式支払手段等に関する事業者（<strong>PayPay</strong> 等含む
          電子マネー等の提供事業者を指す場合があります）のシステムに、
          当社が <strong>利用者の代理</strong> として
          ログインする方法により、取引明細等を
          <strong>自動的に</strong> 取得する
          仕組み（<strong>API 連携</strong>、
          画面連携、スクレイピング等。一般に「電子決済等代行業」等の役務に当たり得る行為）を
          <strong>提供しません</strong>。
        </p>
        <p className={styles.sub} style={{ lineHeight: 1.75, margin: "0.4rem 0" }}>
          家計表示の目的で、当社が取り扱う取引履歴等の内容は、利用者が各事業者の手順に従い自ら書き出し、所定方法で
          当社に送信（アップロード、貼り付け等）した<strong>CSV ファイル等</strong>に含まれる情報に限るものとします。
        </p>
      </section>
      ) : null}

      {activeTab === "privacy" ? (
      <section id="privacy" className={styles.settingsPanel} style={{ marginBottom: "1.5rem" }}>
        <h2 className={styles.title} style={{ marginTop: 0, fontSize: "clamp(1.15rem, 3.5vw, 1.4rem)" }}>
          個人情報の取扱い（抜粋）
        </h2>
        <p className={styles.sub} style={{ lineHeight: 1.75, margin: "0.3rem 0" }}>
          <strong>第7条（個人情報等の取扱い）【抜粋】</strong>
        </p>
        <p className={styles.sub} style={{ lineHeight: 1.75, margin: "0.35rem 0" }}>
          当社は、氏名、メールアドレス、本サービス上で登録・入力された家計データ、および利用者の操作により
          当社のサーバへ送信されたファイルの内容等を、本サービス提供、本人確認、不具合対応、
          法令の遵守、および利用者案内（メール等）の目的の範囲で取り扱います。
        </p>
        <p className={styles.sub} style={{ lineHeight: 1.75, margin: "0.35rem 0" }}>
          なお、当社は金融機関等に利用者代理でログインして明細を自動取得する仕組み（API連携・画面連携・スクレイピング等）を
          <strong>提供しません</strong>。取り扱う取引履歴等は、利用者が自ら送信した CSV 等に含まれる情報に限ります。
        </p>
      </section>
      ) : null}

      {activeTab === "faq" ? (
      <section id="faq" className={styles.settingsPanel} style={{ marginBottom: "1.5rem" }}>
        <h2 className={styles.title} style={{ marginTop: 0, fontSize: "clamp(1.15rem, 3.5vw, 1.4rem)" }}>よくある質問</h2>
        <dl className={styles.reclassifyHint} style={{ lineHeight: 1.75, margin: 0 }}>
          <dt style={{ fontWeight: 700, marginTop: "0.65rem" }}>Q. 銀行口座を連携して、明細を自動取得しますか？</dt>
          <dd style={{ margin: "0.25rem 0 0.85rem", paddingLeft: 0 }}>
            いいえ。銀行等との<strong>API 連携</strong>、<strong>ログイン代行</strong>、<strong>スクレイピング</strong>
            等による明細の自動取得は行いません。銀行・カード明細の取り込みは、利用者が各機関等の手順に従い
            書き出した CSV 等を、自ら所定の画面に貼り付け、またはアップロードする形式です。
          </dd>
          <dt style={{ fontWeight: 700, marginTop: "0.5rem" }}>Q. PayPay の利用者 ID やパスワードを当社に入力・保存しますか？</dt>
          <dd style={{ margin: "0.25rem 0 0.85rem", paddingLeft: 0 }}>
            当社の画面に PayPay の<strong>ログイン情報を求める方式ではありません</strong>。利用者が
            PayPay 公式アプリ等から取引明細の CSV 等を書き出し、所定欄に貼り付けるか
            ファイルをアップロードした内容のみを、家計簿表示の目的で扱います。当社が利用者の銀行等のログイン情報を
            保持することはありません。
          </dd>
        </dl>
      </section>
      ) : null}
    </div>
  );
}
