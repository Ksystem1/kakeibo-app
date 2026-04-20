import { useMemo, useState } from "react";
import type { GradeGroup } from "../lib/api";
import styles from "./ChildGame.module.css";

type Props = {
  gradeGroup: GradeGroup | null | undefined;
};

function gradeTitle(grade: GradeGroup | null | undefined) {
  if (grade === "1-2") return "1-2年生ゲーム";
  if (grade === "3-4") return "3-4年生ゲーム";
  return "5-6年生ゲーム";
}

export function ChildGame({ gradeGroup }: Props) {
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

  const [calcIndex, setCalcIndex] = useState(0);
  const calcItems = useMemo(
    () => [
      { q: "500円持ってて、120円のお菓子を買ったら？", answer: 380, choices: [320, 380, 420] },
      { q: "1000円持ってて、260円の本を買ったら？", answer: 740, choices: [640, 740, 840] },
      { q: "800円持ってて、350円使ったら？", answer: 450, choices: [350, 450, 550] },
    ],
    [],
  );
  const [calcScore, setCalcScore] = useState(0);

  const currentCoin = coinPattern[coinIndex % coinPattern.length];
  const currentQuiz = quizItems[quizIndex % quizItems.length];
  const currentCalc = calcItems[calcIndex % calcItems.length];

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

  return (
    <div className={styles.wrap}>
      <h3 className={styles.title}>{gradeTitle(gradeGroup)}</h3>
      <p className={styles.hint}>3択でおつり計算にチャレンジ</p>
      <p className={styles.question}>{currentCalc.q}</p>
      <div className={styles.choiceRow}>
        {currentCalc.choices.map((c) => (
          <button
            key={c}
            type="button"
            className={styles.choiceBtn}
            onClick={() => {
              if (c === currentCalc.answer) setCalcScore((s) => s + 1);
              setCalcIndex((i) => i + 1);
            }}
          >
            {c}円
          </button>
        ))}
      </div>
      <p className={styles.score}>せいかい: {calcScore} 問</p>
    </div>
  );
}
