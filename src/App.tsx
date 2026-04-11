import { Navigate, Route, Routes } from "react-router-dom";
import { PwaInstallBar } from "./components/PwaInstallBar";
import { AppLayout } from "./components/AppLayout";
import { AdminRoute } from "./components/AdminRoute";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { KakeiboDashboard } from "./components/KakeiboDashboard";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ImportCsvPage } from "./pages/ImportCsvPage";
import { LoginPage } from "./pages/LoginPage";
import { ReceiptPage } from "./pages/ReceiptPage";
import { RegisterPage } from "./pages/RegisterPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { AdminPage } from "./pages/AdminPage";
import { SettingsPage } from "./pages/SettingsPage";
import { DemoDashboardPage } from "./pages/DemoDashboardPage";
import { DashboardPage } from "./pages/DashboardPage";

export default function App() {
  return (
    <>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/demo-dashboard" element={<DemoDashboardPage />} />
      <Route element={<AppLayout />}>
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<KakeiboDashboard />} />
          <Route path="/import" element={<ImportCsvPage />} />
          <Route path="/receipt" element={<ReceiptPage />} />
          <Route path="/members" element={<Navigate to="/settings" replace />} />
          <Route path="/categories" element={<Navigate to="/settings" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route element={<AdminRoute />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <PwaInstallBar />
    </>
  );
}
