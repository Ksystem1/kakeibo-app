import { useEffect, useState } from "react";

/**
 * レシート画面の「スマホ向け UI」（カメラ/ギャラリー分割・全画面ローディング）用。
 * 768px だけだとタブレット横向き等で PC 用の単一ファイル入力になり、更新されていないように見える。
 * 幅 1024px 以下、またはタッチ主体デバイス（pointer: coarse）で true。
 */
const QUERY = "(max-width: 1024px), (pointer: coarse)";

export function useReceiptTouchUi() {
  const [touchUi, setTouchUi] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const m = window.matchMedia(QUERY);
    const fn = () => setTouchUi(m.matches);
    fn();
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);

  return touchUi;
}
