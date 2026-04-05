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
    // skip auth check if viewing an invite
    if (view.page === "invite") return;

    if (getToken()) {
      auth
        .me()
        .then(() => setView({ page: "home" }))
        .catch(() => setView({ page: "login" }));
    }
  }, []);

  return (
    <>
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
      <Player />
    </>
  );
}

export default App;
