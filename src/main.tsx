import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      {(runtime, signOut) => <App runtime={runtime} onSignOut={signOut} />}
    </AuthGate>
  </StrictMode>,
);
