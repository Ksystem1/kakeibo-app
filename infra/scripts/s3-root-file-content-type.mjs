/**
 * dist ルート直下を S3 に置くとき、拡張子だけでは MIME が octet-stream になりがちなファイル向け。
 * 特に manifest.webmanifest は iOS のスタンドアロン起動に必須。
 */
export function extraS3CpFlagsForDistRootFile(name) {
  if (name === "manifest.webmanifest" || name.endsWith(".webmanifest")) {
    return ' --content-type "application/manifest+json; charset=utf-8"';
  }
  if (name === "sw.js" || /^workbox-.+\.js$/i.test(name)) {
    return ' --content-type "application/javascript; charset=utf-8"';
  }
  return "";
}
