import { useState, useEffect } from "react";
import { getToken, auth } from "./lib/api";
import { adoptAccent } from "./lib/theme";
import Login from "./pages/Login";
import Home from "./pages/Home";
import PlaylistView from "./pages/PlaylistView";
import Invite from "./pages/Invite";
import Join from "./pages/Join";
import Player from "./components/Player";

type View =
  | { page: "login" }
  | { page: "home" }
  | { page: "playlist"; id: string }
  | { page: "invite"; token: string }
  | { page: "join"; token: string };

function getInitialView(): View | null {
  const path = window.location.pathname;
  const inviteMatch = path.match(/^\/invite\/([a-f0-9]+)$/);
  if (inviteMatch) return { page: "invite", token: inviteMatch[1] };
  // A collaborator invite redemption link. Same hex-token shape as a share
  // invite, and the same rule: nobody is signed in when they follow it.
  const joinMatch = path.match(/^\/join\/([a-f0-9]+)$/);
  if (joinMatch) return { page: "join", token: joinMatch[1] };
  return null;
}

function App() {
  const [view, setView] = useState<View>(() => getInitialView() || { page: "login" });

  useEffect(() => {
    // skip auth check if viewing an invite (read from URL, not state, so deps stay empty)
    if (window.location.pathname.startsWith("/invite/")) return;
    // Same for a join link: whoever follows one is redeeming an invite, and a
    // stale session token in this browser must not bounce them to Home before
    // they ever see the form.
    if (window.location.pathname.startsWith("/join/")) return;
    if (!getToken()) return;
    let cancelled = false;
    auth
      .me()
      .then((r) => {
        if (cancelled) return;
        // A second browser (or a cleared cache) has no local accent — take the
        // one stored on the account so the owner's locker looks the same
        // everywhere they sign in.
        adoptAccent(r.user.accent);
        setView({ page: "home" });
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
        {view.page === "join" && (
          <Join
            token={view.token}
            onAuth={() => {
              // Drop the (now spent) invite token from the address bar before
              // showing Home — otherwise a refresh returns to this page and the
              // API truthfully reports the invite is no longer valid, which
              // reads as "the account I just made is broken".
              window.history.replaceState(null, "", "/");
              setView({ page: "home" });
            }}
          />
        )}
      </div>
      <Player />
    </>
  );
}

export default App;
