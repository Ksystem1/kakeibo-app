import { useEffect, useState } from "react";

const MQ = "(max-width: 768px)";

export function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MQ).matches,
  );

  useEffect(() => {
    const m = window.matchMedia(MQ);
    const fn = () => setMobile(m.matches);
    fn();
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);

  return mobile;
}
