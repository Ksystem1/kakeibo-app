import type { ReactNode } from "react";
import styles from "./LoginScreen.module.css";

type Props = { children: ReactNode };

export function AuthHeroAside({ children }: Props) {
  return (
    <aside className={styles.hero}>
      <div className={styles.heroVisual} aria-hidden="true">
        <img
          src={`${import.meta.env.BASE_URL}top-hero.png`}
          alt=""
          className={styles.heroImg}
          width={1024}
          height={1024}
          loading="eager"
          decoding="async"
        />
      </div>
      <div className={styles.heroInner}>{children}</div>
    </aside>
  );
}
