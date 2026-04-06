import { useState, useEffect } from "react";
import { getToken, auth } from "./lib/api";
import Login from "./pages/Login";
import Home from "./pages/Home";
import PlaylistView from "./pages/PlaylistView";
import Invite from "./pages/Invite";
import Player from "./components/Player";

type View =
  | { page: "login" }
  | { page: "home" }
  | { page: "playlist"; id: string }
  | { page: "invite"; token: string };

function getInitialView(): View | null {
  const path = window.location.pathname;
  const inviteMatch = path.match(/^\/invite\/([a-f0-9]+)$/);
  if (inviteMatch) return { page: "invite", token: inviteMatch[1] };
  return null;
}

function App() {
  const [view, setView] = useState<View>(() => getInitialView() || { page: "login" });

  useEffect(() => {
    // skip auth check if viewing an invite (read from URL, not state, so deps stay empty)
    if (window.location.pathname.startsWith("/invite/")) return;
    if (!getToken()) return;
    let cancelled = false;
    auth
      .me()
      .then(() => {
        if (!cancelled) setView({ page: "home" });
      })
      .catch(() => {
        if (!cancelled) setView({ page: "login" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="app-container">
        {view.page === "login" && (
          <Login onAuth={() => setView({ page: "home" })} />
        )}
        {view.page === "home" && (
          <Home
            onSelect={(id) => setView({ page: "playlist", id })}
            onLogout={() => setView({ page: "login" })}
          />
        )}
        {view.page === "playlist" && (
          <PlaylistView
            playlistId={view.id}
            onBack={() => setView({ page: "home" })}
          />
        )}
        {view.page === "invite" && <Invite token={view.token} />}
      </div>
      <Player />
    </>
  );
}

export default App;
