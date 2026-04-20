export type PuzzleHint = {
  amount?: number | null;
  memo?: string | null;
};

export type MathPuzzle = {
  prompt: string;
  answer: number;
  type: 1 | 2 | 3;
  hintNumbers: number[];
};

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}

export function generateMathPuzzle(hint?: PuzzleHint | null): MathPuzzle {
  const hintAmount =
    hint?.amount != null && Number.isFinite(Number(hint.amount))
      ? Math.max(0, Math.round(Number(hint.amount)))
      : null;

  const seed = randomInt(1, 3) as 1 | 2 | 3;

  if (seed === 1) {
    const wallet = pick([1000, 1200, 1500, 1800, 2000]);
    const change = randomInt(120, 780);
    const price = wallet - change;
    return {
      type: 1,
      answer: price,
      hintNumbers: [wallet, change, ...(hintAmount != null ? [hintAmount] : [])],
      prompt:
        `私は${wallet}円を持って店に行った。` +
        `店主はニヤリと笑い、${change}円をおつりとして渡した。` +
        "さて、私が買ったものの代金はいくら？",
    };
  }

  if (seed === 2) {
    const wallet = pick([1200, 1500, 1800, 2000]);
    const price = randomInt(280, 920);
    const change = wallet - price;
    const c500 = Math.floor(change / 500);
    const r1 = change % 500;
    const c100 = Math.floor(r1 / 100);
    const r2 = r1 % 100;
    const c10 = Math.floor(r2 / 10);
    return {
      type: 2,
      answer: change,
      hintNumbers: [wallet, price, ...(hintAmount != null ? [hintAmount] : [])],
      prompt:
        `遺跡の記録にはこうある。「持ち金は${wallet}円。買い物は${price}円」。` +
        `ではおつりは、500円玉${c500}枚、100円玉${c100}枚、10円玉${c10}枚。` +
        "おつりの合計はいくら？",
    };
  }

  const a = randomInt(120, 460);
  const b = randomInt(150, 520);
  const wallet = pick([1200, 1500, 1800, 2000]);
  const answer = wallet - (a + b);
  return {
    type: 3,
    answer,
    hintNumbers: [wallet, a, b, ...(hintAmount != null ? [hintAmount] : [])],
    prompt:
      `石板に二つの品の値段が刻まれている。品Aは${a}円、品Bは${b}円。` +
      `探検家の所持金は${wallet}円。` +
      "二つを買ったあと残るおつりはいくら？",
  };
}
