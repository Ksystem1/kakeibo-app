import { useEffect, useState } from "react";
import { getPublicSettings } from "../lib/api";

export type PublicMonitorSettings = {
  is_monitor_mode: boolean;
  monitor_recruitment_text: string;
  monitor_recruitment_capacity: number;
  monitor_recruitment_filled: number;
  monitor_recruitment_remaining: number | null;
};

const defaultState: PublicMonitorSettings = {
  is_monitor_mode: false,
  monitor_recruitment_text: "",
  monitor_recruitment_capacity: 0,
  monitor_recruitment_filled: 0,
  monitor_recruitment_remaining: null,
};

/**
 * ログイン前トップ等用。60秒ごとに再取得して残席を更新。
 */
export function usePublicMonitorSettings() {
  const [settings, setSettings] = useState<PublicMonitorSettings>(defaultState);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const s = await getPublicSettings();
        if (cancelled) return;
        setSettings({
          is_monitor_mode: s.is_monitor_mode === true,
          monitor_recruitment_text: String(s.monitor_recruitment_text ?? "").trim(),
          monitor_recruitment_capacity: Math.max(0, Number(s.monitor_recruitment_capacity) || 0),
          monitor_recruitment_filled: Math.max(0, Number(s.monitor_recruitment_filled) || 0),
          monitor_recruitment_remaining:
            s.monitor_recruitment_remaining == null ? null : Math.max(0, Number(s.monitor_recruitment_remaining)),
        });
      } catch {
        if (!cancelled) setSettings(defaultState);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const showLimitedLandingPromo =
    settings.is_monitor_mode &&
    settings.monitor_recruitment_text !== "" &&
    settings.monitor_recruitment_capacity > 0;

  return { settings, loading, showLimitedLandingPromo };
}
