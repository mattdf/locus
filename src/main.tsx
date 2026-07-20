import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import { SharedChatView } from "./components/SharedChatView";
import "./styles.css";

const sharedToken = window.location.pathname.match(/^\/share\/([A-Za-z0-9_-]{43})\/?$/)?.[1];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {sharedToken ? (
      <SharedChatView token={sharedToken} />
    ) : (
      <AuthGate>
        {(runtime, signOut) => <App runtime={runtime} onSignOut={signOut} />}
      </AuthGate>
    )}
  </StrictMode>,
);
