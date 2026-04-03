/**
 * public/sitemap.xml を生成する（ビルド前に実行）
 *
 *   node scripts/generate-sitemap.mjs
 *
 * 環境変数:
 *   SITE_ORIGIN — 既定 https://ksystemapp.com（末尾スラッシュなし）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outFile = path.join(repoRoot, "public", "sitemap.xml");

const origin = String(process.env.SITE_ORIGIN || "https://ksystemapp.com").replace(
  /\/$/,
  "",
);
const basePath = "/kakeibo";
const lastmod = new Date().toISOString().slice(0, 10);

/** @type {Array<{ path: string; changefreq: string; priority: string }>} */
const routes = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/login", changefreq: "monthly", priority: "0.9" },
  { path: "/register", changefreq: "monthly", priority: "0.9" },
  { path: "/forgot-password", changefreq: "monthly", priority: "0.5" },
  { path: "/reset-password", changefreq: "yearly", priority: "0.3" },
  { path: "/import", changefreq: "monthly", priority: "0.6" },
  { path: "/receipt", changefreq: "monthly", priority: "0.6" },
  { path: "/members", changefreq: "monthly", priority: "0.6" },
  { path: "/categories", changefreq: "monthly", priority: "0.6" },
  { path: "/settings", changefreq: "monthly", priority: "0.5" },
  { path: "/admin", changefreq: "monthly", priority: "0.3" },
];

function toLoc(routePath) {
  const normalized = routePath === "/" ? "" : routePath.replace(/^\//, "");
  const suffix = normalized === "" ? "/" : `/${normalized}`;
  return `${origin}${basePath}${suffix}`;
}

const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (r) => `  <url>
    <loc>${toLoc(r.path)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, body, "utf8");
console.error(`[sitemap] wrote ${path.relative(repoRoot, outFile)} (${routes.length} URLs, origin=${origin})`);
