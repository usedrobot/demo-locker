// Content types are attacker-controlled: the browser sends them with the
// multipart upload and we used to store and echo them verbatim. On the
// Cloudflare and standalone targets the web app and the API share an origin, so
// an "artwork" stored as text/html executed in the app's origin the moment
// anyone opened its URL — with the session token sitting in localStorage next
// to it. Hence an allowlist, applied at BOTH ends: on upload, so nothing new
// gets in, and on serve, so rows stored before this existed are neutralised
// without a data migration.

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
// Deliberately excluded: image/svg+xml. SVG carries script and runs it on a
// top-level navigation, which is exactly the case this allowlist exists for.

const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/opus",
  "audio/aiff",
  "audio/x-aiff",
]);

// Strip any parameters (`; charset=...`) and normalise case before matching.
function bare(type: string | undefined | null): string {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

export function isAllowedImageType(type: string | undefined | null): boolean {
  return IMAGE_TYPES.has(bare(type));
}

// What to actually put on the wire. Anything not on the allowlist is served as
// an opaque download rather than 404'd, so an odd-but-harmless file already in
// a bucket still reaches its owner — it just can never be interpreted as markup
// by the browser.
export function safeImageType(type: string | undefined | null): string {
  return isAllowedImageType(type) ? bare(type) : "application/octet-stream";
}

export function safeAudioType(type: string | undefined | null): string {
  return AUDIO_TYPES.has(bare(type)) ? bare(type) : "application/octet-stream";
}

// Belt and braces for every route that streams stored bytes. nosniff stops the
// browser from second-guessing the type we just sanitised; the CSP makes the
// response inert even if some future path lets a text/html slip through.
export const INERT_CONTENT_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};
