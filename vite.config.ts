import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget =
    env.VITE_API_PROXY_TARGET?.replace(/\/$/, "") || "http://127.0.0.1:3456";

  /** マニフェストの scope / id はパス形式に統一（絶対URLは iOS のスタンドアロン起動で不具合報告あり） */
  const pwaScope = "/kakeibo/";
  /** 末尾スラッシュのみの /kakeibo/ がオリジンで 500 等になると PWA 起動が「書類 -0KB」になる。/login は HTML が安定して返る */
  const pwaStartUrl = "/kakeibo/login";
  const pwaIcon = "/kakeibo/brand-kakeibo-2.png";

  return {
    // 本番: https://ksystemapp.com/kakeibo/（CloudFront+S3）。ローカルは http://localhost:5173/kakeibo/
    base: "/kakeibo/",
    plugins: [
      react(),
      VitePWA({
        /**
         * autoUpdate: 新 SW 取得時に onNeedRefresh（main でサイレント有効化のみ・現在タブはリロードしない）。
         * skipWaiting + clientsClaim: 新 SW が待機→アクティブ化しやすく、次回起動で最新 precache を参照しやすい。
         */
        registerType: "autoUpdate",
        workbox: {
          clientsClaim: true,
          skipWaiting: true,
          cleanupOutdatedCaches: true,
          navigateFallback: "/kakeibo/index.html",
          navigateFallbackDenylist: [
            /^\/kakeibo\/sw\.js$/,
            /^\/kakeibo\/workbox-[^/]+\.js$/i,
            /\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|json|webmanifest|map|txt|xml|woff2?)$/i,
          ],
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webp}"],
          runtimeCaching: [
            {
              urlPattern: ({ request }) =>
                request.destination === "script" ||
                request.destination === "style" ||
                request.destination === "image" ||
                request.destination === "font",
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "kakeibo-static-assets",
                expiration: {
                  maxEntries: 120,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
              },
            },
          ],
        },
        includeAssets: ["robots.txt", "og-image.png", "top-hero.png"],
        manifest: {
          id: pwaScope,
          name: "Kakeibo 家計簿",
          short_name: "Kakeibo",
          description: "家族で共有できる家計簿アプリ",
          lang: "ja",
          start_url: pwaStartUrl,
          scope: pwaScope,
          display: "standalone",
          display_override: ["standalone", "browser"],
          orientation: "portrait",
          background_color: "#f5f8fc",
          theme_color: "#ffd166",
          icons: [
            {
              src: pwaIcon,
              sizes: "1024x1024",
              type: "image/png",
              purpose: "any",
            },
            {
              src: pwaIcon,
              sizes: "1024x1024",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
      }),
    ],
    server: {
      // 0.0.0.0 で待ち受け — PC は http://localhost:5173、同一 Wi‑Fi のスマホは http://<このPCのIP>:5173
      host: true,
      port: 5173,
      strictPort: true,
      // 開発: VITE_API_URL 未設定時は api.ts が /api を使う → ここで backend に転送（CORS 不要）
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
