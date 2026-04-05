import { useState, useEffect } from "react";
import { getToken, auth } from "./lib/api";
import Login from "./pages/Login";
import Home from "./pages/Home";
import PlaylistView from "./pages/PlaylistView";
import Player from "./components/Player";

type View =
  | { page: "login" }
  | { page: "home" }
  | { page: "playlist"; id: string };

function App() {
  const [view, setView] = useState<View>({ page: "login" });

  useEffect(() => {
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
      <Player />
    </>
  );
}

export default App;
