import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth.js";
import playlists from "./routes/playlists.js";
import comments from "./routes/comments.js";
import shares from "./routes/shares.js";
import tracks from "./routes/tracks.js";
import publicRouter from "./routes/public.js";
import type { Env } from "./types.js";

const app = new Hono<Env>();

app.use("/*", cors());

// no caching on API responses by default — but never clobber a
// Cache-Control a handler set deliberately (e.g. private artwork's
// `private, max-age=3600`, public metadata's `public, max-age=60`).
app.use("/*", async (c, next) => {
  await next();
  if (!c.res.headers.get("Cache-Control")) {
    c.header("Cache-Control", "no-store");
  }
});

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// On the Cloudflare Workers deployment, this route never actually executes:
// Workers assets are served ahead of the Worker by Cloudflare's assets-first
// routing, so a built /embed.js asset in the deploy answers the request
// before Hono runs. This handler only serves /embed.js on Node/standalone
// (self-hosted) deployments where there is no separate asset layer.
app.get("/embed.js", (c) => {
  if (!c.env.EMBED_JS) {
    return c.text("player bundle not available on this deployment", 404);
  }
  return new Response(c.env.EMBED_JS, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

// On the Cloudflare Workers deployment, this route never actually executes:
// Workers assets are served ahead of the Worker by Cloudflare's assets-first
// routing, so a built /openapi.json asset in the deploy answers the request
// before Hono runs. This handler only serves /openapi.json on Node/standalone
// (self-hosted) deployments where there is no separate asset layer.
app.get("/openapi.json", (c) => {
  if (!c.env.OPENAPI_JSON) {
    return c.text("openapi description not available on this deployment", 404);
  }
  return new Response(c.env.OPENAPI_JSON, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

app.route("/auth", auth);
app.route("/playlists", playlists);
app.route("/comments", comments);
app.route("/shares", shares);
app.route("/tracks", tracks);
app.route("/public/v1", publicRouter);

export default app;
