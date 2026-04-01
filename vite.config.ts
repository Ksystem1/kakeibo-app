import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 本番: https://ksystemapp.com/kakeibo/（CloudFront+S3）。ローカルは http://localhost:5173/kakeibo/
  base: "/kakeibo/",
  plugins: [react()],
  server: {
    // 0.0.0.0 で待ち受け — PC は http://localhost:5173、同一 Wi‑Fi のスマホは http://<このPCのIP>:5173
    host: true,
    port: 5173,
    strictPort: true,
  },
});
