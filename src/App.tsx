import { useState } from "react";
import { LoginScreen } from "./components/LoginScreen";
import { DevApiTest } from "./components/DevApiTest";

type Screen = "login" | "api";

function App() {
  const [screen, setScreen] = useState<Screen>("login");

  return (
    <>
      <nav className="appNav" aria-label="開発メニュー">
        <button
          type="button"
          data-active={screen === "login"}
          onClick={() => setScreen("login")}
        >
          ログイン
        </button>
        <button
          type="button"
          data-active={screen === "api"}
          onClick={() => setScreen("api")}
        >
          API・DBテスト
        </button>
      </nav>
      {screen === "login" ? <LoginScreen /> : <DevApiTest />}
    </>
  );
}

export default App;
