import confetti from "canvas-confetti";
import type { KidTheme } from "./api";

const PASTEL_BLUE = [
  "#b8d4ff",
  "#cfe8ff",
  "#ffe8cc",
  "#ffc9dd",
  "#c8f7dc",
  "#e4dcff",
  "#fff59d",
];

const PASTEL_PINK = [
  "#ffc9e8",
  "#ffd6e8",
  "#ffe8f0",
  "#fff3bf",
  "#d4e8ff",
  "#c5f6fa",
  "#e9d5ff",
];

/** 取引保存成功のご褒美演出（パステル紙吹雪） */
export function celebrateKidTransactionSaved(theme: KidTheme) {
  const colors = theme === "pink" ? PASTEL_PINK : PASTEL_BLUE;
  const base = {
    colors,
    ticks: 240,
    gravity: 1.02,
    scalar: 1.08,
    decay: 0.93,
    startVelocity: 32,
    zIndex: 9999,
    disableForReducedMotion: true,
  } as const;

  void confetti({
    ...base,
    particleCount: 115,
    spread: 74,
    origin: { y: 0.66 },
  });
  void confetti({
    ...base,
    particleCount: 48,
    angle: 58,
    spread: 52,
    origin: { x: 0.04, y: 0.6 },
  });
  void confetti({
    ...base,
    particleCount: 48,
    angle: 122,
    spread: 52,
    origin: { x: 0.96, y: 0.6 },
  });
}
