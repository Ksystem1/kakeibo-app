import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import { AuthProvider } from "./context/AuthContext";
import { FeaturePermissionProvider } from "./context/FeaturePermissionContext";
import { SettingsProvider } from "./context/SettingsContext";
import {
  registerPwaBackgroundUpdateChecks,
  silentlyActivateWaitingServiceWorker,
} from "./lib/pwaSilentUpdate";
import "./index.css";

registerSW({
  immediate: true,
  onNeedRefresh() {
    void silentlyActivateWaitingServiceWorker();
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    const tenMinutes = 10 * 60 * 1000;
    setInterval(() => {
      void registration.update();
    }, tenMinutes);
  },
});
registerPwaBackgroundUpdateChecks();

const routerBasename =
  import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={routerBasename}>
      <AuthProvider>
        <FeaturePermissionProvider>
          <SettingsProvider>
            <App />
          </SettingsProvider>
        </FeaturePermissionProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
