import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth.js";
import playlists from "./routes/playlists.js";
import comments from "./routes/comments.js";
import shares from "./routes/shares.js";
import tracks from "./routes/tracks.js";
import type { Env } from "./types.js";

const app = new Hono<Env>();

app.use("/*", cors());

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.route("/auth", auth);
app.route("/playlists", playlists);
app.route("/comments", comments);
app.route("/shares", shares);
app.route("/tracks", tracks);

export default app;
