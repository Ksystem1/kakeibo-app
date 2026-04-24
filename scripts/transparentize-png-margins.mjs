/**
 * スキン PNG などで、外周の「余白色」（左上ピクセル基準）を透明にする。
 * 辺上から BFS するのでアイコン内部の同色は滲まない想定（アイコンは端にぴったり乗らない形）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const TOL = 20;

function marginToTransparentRgba(rgba, width, height) {
  const refR = rgba[0];
  const refG = rgba[1];
  const refB = rgba[2];
  const n = width * height;
  const inQ = new Uint8Array(n);
  const q = [];

  const match = (byte) =>
    Math.abs(rgba[byte] - refR) <= TOL &&
    Math.abs(rgba[byte + 1] - refG) <= TOL &&
    Math.abs(rgba[byte + 2] - refB) <= TOL;

  const push = (p) => {
    if (inQ[p]) return;
    const b = p * 4;
    if (!match(b)) return;
    inQ[p] = 1;
    q.push(p);
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + (width - 1));
  }

  let i = 0;
  while (i < q.length) {
    const p = q[i++];
    const b = p * 4;
    rgba[b + 3] = 0;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
  }
  return rgba;
}

async function processPngFile(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("expected RGBA");
  const buf = new Uint8Array(marginToTransparentRgba(Uint8Array.from(data), info.width, info.height));
  await sharp(buf, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toFile(file);
}

function walkPngs(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .map((f) => path.join(dir, f));
}

async function main() {
  const roots = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [path.join("public", "skins", "Tmp02"), path.join("public", "skins", "Tmp03")];
  for (const sub of roots) {
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) {
      console.error("skip (no dir):", sub);
      continue;
    }
    for (const png of walkPngs(sub)) {
      process.stdout.write(`${png} `);
      await processPngFile(png);
      console.log("ok");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
