# Security

## Reporting a vulnerability

Report privately through GitHub's [security advisory
form](https://github.com/usedrobot/demo-locker/security/advisories/new) rather
than opening a public issue. Include what you did, what happened, and what you
expected — a curl sequence is ideal.

This is a small project maintained by one person; expect a first response
within a week rather than within hours.

## What Demo Locker assumes

Understanding the model saves reporting things that are working as designed.

- **A share link is a capability.** Anyone holding the URL has whatever the link
  grants (listen, or listen + edit), with no account. Links do not currently
  expire; revoke them from the access panel when you are done with them.
- **Anonymous comment names are self-declared.** A listener on a share link
  types their own name, so a name is not an identity claim.
- **Public playlists are fully public.** Marking a playlist public serves its
  metadata, artwork and streams to anyone, unauthenticated, by design — that is
  what the embed player consumes.
- **Registration closes after the first account.** An instance is one person's
  locker. `ALLOW_SIGNUP=true` reopens it if you actually want a shared one.
- **The lossless original is downloadable** by anyone with access to the
  playlist, via `GET /tracks/:id/download`. Streaming serves a compressed
  rendition; the original is deliberately reachable, not leaked.

## Known accepted risks

Documented so they are not rediscovered as findings — each is a tradeoff, not an
oversight, and each has a cost we have chosen not to pay yet.

- **Session tokens ride in `?token=` query parameters for media URLs.** `<audio>`
  and `<img>` cannot send an `Authorization` header, so streaming and artwork
  accept the token as a query param. That puts credentials in access logs and
  browser history. The fix is short-lived signed media URLs, which is a feature
  rather than a patch.
- **CORS is `*`.** The API is meant to be embeddable from any origin and
  authenticates with a Bearer header rather than an ambient cookie, so a hostile
  page cannot ride a logged-in session. It does mean a *stolen* token works from
  anywhere.
- **The session token lives in `localStorage`.** Any successful XSS on the app's
  origin reads it. The mitigations are on the XSS side: uploads are content-type
  allowlisted and every stored-byte response carries `nosniff` and a restrictive
  CSP.

## Hardening a deployment

- Put a real IP in front of the rate limiter. It keys on `CF-Connecting-IP`
  (automatic on Cloudflare) or `X-Forwarded-For`. Behind a proxy that sets
  neither, every caller shares one bucket.
- Set `MAX_STORAGE_BYTES` and `MAX_UPLOAD_BYTES` if the instance is reachable by
  anyone you do not know.
- Leave `ALLOW_SIGNUP` unset unless you genuinely want open registration.

See [docs/self-hosting.md](docs/self-hosting.md) for the full settings table.

## Supported versions

Fixes land on the latest release only.

| Version | Supported |
|---|---|
| 0.2.8 and later | ✅ |
| 0.2.7 | ❌ — published from a tree missing its own security commit. It is 0.2.6's code with a bumped version number. Use 0.2.8. |
| earlier | ❌ |
