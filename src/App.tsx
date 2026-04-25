import { Navigate, Route, Routes } from "react-router-dom";
import { PullToRefresh } from "./components/PullToRefresh";
import { PwaInstallBar } from "./components/PwaInstallBar";
import { AppLayout } from "./components/AppLayout";
import { AdminRoute } from "./components/AdminRoute";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { HomeLedgerGate } from "./components/HomeLedgerGate";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ImportCsvPage } from "./pages/ImportCsvPage";
import { LoginPage } from "./pages/LoginPage";
import { ReceiptPage } from "./pages/ReceiptPage";
import { RegisterPage } from "./pages/RegisterPage";
import { PasskeyRegisterPage } from "./pages/PasskeyRegisterPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { AdminPage } from "./pages/AdminPage";
import { AdminSupportChatPage } from "./pages/AdminSupportChatPage";
import { SupportChatPage } from "./pages/SupportChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { DemoDashboardPage } from "./pages/DemoDashboardPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ChildProfileSelectPage } from "./pages/ChildProfileSelectPage";
import { MedicalDeductionPage } from "./pages/MedicalDeductionPage";
import { LegalInfoPage } from "./pages/LegalInfoPage";

export default function App() {
  return (
    <>
    <PullToRefresh />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/register/passkey" element={<PasskeyRegisterPage />} />
      <Route path="/join" element={<PasskeyRegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/demo-dashboard" element={<DemoDashboardPage />} />
      <Route element={<AppLayout />}>
        <Route path="/legal" element={<LegalInfoPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<HomeLedgerGate />} />
          <Route path="/import" element={<ImportCsvPage />} />
          <Route path="/receipt" element={<ReceiptPage />} />
          <Route path="/members" element={<Navigate to="/settings" replace />} />
          <Route path="/categories" element={<Navigate to="/settings" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/medical-deduction" element={<MedicalDeductionPage />} />
          <Route path="/support" element={<SupportChatPage />} />
          <Route path="/child-select" element={<ChildProfileSelectPage />} />
          <Route element={<AdminRoute />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/chat" element={<AdminSupportChatPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <PwaInstallBar />
    </>
  );
}
