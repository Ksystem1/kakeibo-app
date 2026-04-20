import { useMemo, useState } from "react";
import type { GradeGroup } from "../lib/api";
import { generateMathPuzzle, type PuzzleHint } from "../lib/generateMathPuzzle";
import styles from "./ChildGame.module.css";

type Props = {
  gradeGroup: GradeGroup | null | undefined;
  ledgerHint?: PuzzleHint | null;
};

function gradeTitle(grade: GradeGroup | null | undefined) {
  if (grade === "1-2") return "1-2年生ゲーム";
  if (grade === "3-4") return "3-4年生ゲーム";
  if (grade === "5-6") return "5-6年生ゲーム";
  return "3-4年生ゲーム";
}

export function ChildGame({ gradeGroup, ledgerHint }: Props) {
  const [walletPos, setWalletPos] = useState<"left" | "center" | "right">("center");
  const [coinIndex, setCoinIndex] = useState(0);
  const coinPattern = useMemo(
    () => [
      { lane: "left", value: 10 },
      { lane: "right", value: 100 },
      { lane: "center", value: 10 },
      { lane: "left", value: 100 },
    ],
    [],
  );
  const [coinScore, setCoinScore] = useState(0);

  const [quizIndex, setQuizIndex] = useState(0);
  const quizItems = useMemo(
    () => [
      { item: "りんご", answer: 120, choices: [120, 80, 200] },
      { item: "えんぴつ", answer: 80, choices: [50, 80, 150] },
      { item: "ノート", answer: 150, choices: [100, 150, 300] },
    ],
    [],
  );
  const [quizScore, setQuizScore] = useState(0);

  const [dialHundreds, setDialHundreds] = useState(0);
  const [dialTens, setDialTens] = useState(0);
  const [dialOnes, setDialOnes] = useState(0);
  const [phase, setPhase] = useState<"idle" | "success" | "fail">("idle");
  const [solvedCount, setSolvedCount] = useState(0);
  const [shakeKey, setShakeKey] = useState(0);
  const [puzzle, setPuzzle] = useState(() => generateMathPuzzle(ledgerHint));

  const currentCoin = coinPattern[coinIndex % coinPattern.length];
  const currentQuiz = quizItems[quizIndex % quizItems.length];
  if (gradeGroup === "1-2") {
    return (
      <div className={styles.wrap}>
        <h3 className={styles.title}>{gradeTitle(gradeGroup)}</h3>
        <p className={styles.hint}>コインが落ちるレーンにおさいふをタップで合わせよう！</p>
        <div className={styles.coinLanes}>
          {["left", "center", "right"].map((lane) => (
            <button
              key={lane}
              type="button"
              className={`${styles.laneButton} ${walletPos === lane ? styles.laneSelected : ""}`}
              onClick={() => setWalletPos(lane as "left" | "center" | "right")}
            >
              {currentCoin.lane === lane ? `${currentCoin.value}円` : "　"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.playBtn}
          onClick={() => {
            if (walletPos === currentCoin.lane) setCoinScore((s) => s + currentCoin.value);
            setCoinIndex((i) => i + 1);
          }}
        >
          キャッチ！
        </button>
        <p className={styles.score}>スコア: {coinScore} 点</p>
      </div>
    );
  }

  if (gradeGroup === "3-4") {
    return (
      <div className={styles.wrap}>
        <h3 className={styles.title}>{gradeTitle(gradeGroup)}</h3>
        <p className={styles.hint}>イラストの値段をあてよう</p>
        <p className={styles.question}>この「{currentQuiz.item}」はいくら？</p>
        <div className={styles.choiceRow}>
          {currentQuiz.choices.map((c) => (
            <button
              key={c}
              type="button"
              className={styles.choiceBtn}
              onClick={() => {
                if (c === currentQuiz.answer) setQuizScore((s) => s + 1);
                setQuizIndex((i) => i + 1);
              }}
            >
              {c}円
            </button>
          ))}
        </div>
        <p className={styles.score}>せいかい: {quizScore} 問</p>
      </div>
    );
  }

  if (gradeGroup !== "5-6") {
    return (
      <div className={styles.wrap}>
        <h3 className={styles.title}>{gradeTitle(gradeGroup)}</h3>
        <p className={styles.hint}>イラストの値段をあてよう</p>
        <p className={styles.question}>この「{currentQuiz.item}」はいくら？</p>
        <div className={styles.choiceRow}>
          {currentQuiz.choices.map((c) => (
            <button
              key={c}
              type="button"
              className={styles.choiceBtn}
              onClick={() => {
                if (c === currentQuiz.answer) setQuizScore((s) => s + 1);
                setQuizIndex((i) => i + 1);
              }}
            >
              {c}円
            </button>
          ))}
        </div>
        <p className={styles.score}>せいかい: {quizScore} 問</p>
      </div>
    );
  }

  return (
    <div className={styles.ruinsWrap}>
      <h3 className={styles.title}>{gradeTitle(gradeGroup)}: 遺跡脱出</h3>
      <p className={styles.hint}>おこづかい帳の入力が、暗号を解くヒントになる。</p>
      <div className={styles.ruinsWall}>
        <p className={styles.ruinsStory}>
          探検家は石の扉に閉じ込められた。壁に刻まれた暗号を解き、3つのダイヤルに代金を入力せよ。
        </p>
        <p className={styles.question}>{puzzle.prompt}</p>
        <div className={styles.wallHint}>
          <strong>壁の刻印（今日のヒント）:</strong>{" "}
          {ledgerHint?.amount != null ? `${Math.round(Number(ledgerHint.amount))}円` : "金額なし"} /{" "}
          {ledgerHint?.memo?.trim() ? ledgerHint.memo.trim() : "項目なし"}
        </div>
        <div className={styles.wallHintNumbers}>
          暗号に現れた数字: {puzzle.hintNumbers.map((n) => String(n)).join(" / ")}
        </div>
      </div>

      <div
        key={shakeKey}
        className={`${styles.doorArea} ${phase === "success" ? styles.doorOpen : ""} ${phase === "fail" ? styles.doorTrap : ""}`}
      >
        <div className={styles.dialRow}>
          <label className={styles.dialLabel}>
            百
            <input
              type="number"
              min={0}
              max={9}
              className={styles.dialInput}
              value={dialHundreds}
              onChange={(e) => setDialHundreds(Math.max(0, Math.min(9, Number(e.target.value) || 0)))}
            />
          </label>
          <label className={styles.dialLabel}>
            十
            <input
              type="number"
              min={0}
              max={9}
              className={styles.dialInput}
              value={dialTens}
              onChange={(e) => setDialTens(Math.max(0, Math.min(9, Number(e.target.value) || 0)))}
            />
          </label>
          <label className={styles.dialLabel}>
            一
            <input
              type="number"
              min={0}
              max={9}
              className={styles.dialInput}
              value={dialOnes}
              onChange={(e) => setDialOnes(Math.max(0, Math.min(9, Number(e.target.value) || 0)))}
            />
          </label>
        </div>
        <button
          type="button"
          className={styles.playBtn}
          onClick={() => {
            const answer = dialHundreds * 100 + dialTens * 10 + dialOnes;
            if (answer === puzzle.answer) {
              setPhase("success");
              setSolvedCount((v) => v + 1);
            } else {
              setPhase("fail");
              setShakeKey((k) => k + 1);
            }
          }}
        >
          ダイヤルを確定
        </button>
      </div>

      {phase === "success" ? (
        <p className={styles.successText}>脱出成功！石の扉が開いた！</p>
      ) : phase === "fail" ? (
        <p className={styles.failText}>もう一度考えろ。罠が作動した！</p>
      ) : null}

      <div className={styles.choiceRow}>
        <button
          type="button"
          className={styles.choiceBtn}
          onClick={() => {
            setPuzzle(generateMathPuzzle(ledgerHint));
            setDialHundreds(0);
            setDialTens(0);
            setDialOnes(0);
            setPhase("idle");
          }}
        >
          次の暗号へ
        </button>
      </div>
      <p className={styles.score}>脱出した扉: {solvedCount} 枚</p>
    </div>
  );
}
