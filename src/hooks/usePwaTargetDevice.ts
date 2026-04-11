import { useEffect, useState } from "react";

/**
 * パソコン向けには PWA 案内を出さない。
 * タブレット・スマホ相当: 幅が狭い、または主にタッチ操作とみなせる環境。
 */
const MQ = "(max-width: 1024px), (pointer: coarse)";

function looksLikeDesktopPc(): boolean {
  const ua = navigator.userAgent;
  const desktopOs =
    /Windows NT|Macintosh|X11|Linux x86_64|Linux x86_32/i.test(ua) &&
    !/Android|iPhone|iPad|iPod|Mobile|webOS/i.test(ua);
  const wide = window.matchMedia("(min-width: 900px)").matches;
  const fine = window.matchMedia("(pointer: fine)").matches;
  return desktopOs && wide && fine;
}

export function usePwaTargetDevice(): boolean {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const m = window.matchMedia(MQ);
    const sync = () => {
      setOk(m.matches && !looksLikeDesktopPc());
    };
    sync();
    m.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      m.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return ok;
}
