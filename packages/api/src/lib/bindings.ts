// The env vars the Node/self-hosted entry point forwards into Worker-style
// bindings.
//
// This list is a place things get forgotten: on Workers every binding in
// wrangler.jsonc arrives automatically, but on Node each one has to be copied
// across by hand, and a missed name fails silently — the feature simply never
// activates, exactly as MAX_STORAGE_BYTES did for four releases and as
// ALLOW_SIGNUP did within an hour of being written. Hence one exported list,
// one builder, and a test that walks it.

export const FORWARDED_ENV_VARS = [
  "MAX_PLAYLISTS",
  "MAX_STORAGE_BYTES",
  "MAX_COLLABORATORS",
  "MAX_SHARE_LINKS",
  "MAX_UPLOAD_BYTES",
  "ALLOW_SIGNUP",
] as const;

export function forwardedEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of FORWARDED_ENV_VARS) out[name] = env[name];
  return out;
}
