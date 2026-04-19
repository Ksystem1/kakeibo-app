import { KakeiboDashboard } from "../components/KakeiboDashboard";

/**
 * 家族ロール KID 向けのお小遣い帳トップ。
 * 取引・残高 UI は KakeiboDashboard の子どもモードに委譲（API の KID スコープと整合）。
 */
export function KidAllowanceLedgerPage() {
  return <KakeiboDashboard ledgerMode="kidAllowance" />;
}
