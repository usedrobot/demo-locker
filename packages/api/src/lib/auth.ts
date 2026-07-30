// Web Crypto API — works in Cloudflare Workers

// OWASP's current floor for PBKDF2-SHA256. The original 100k shipped in 0.1 and
// every hash written before this release is still at that cost, so verify()
// reads the cost out of the stored string and the login route silently rehashes
// on the next successful sign-in. Nobody has to reset a password.
export const PBKDF2_ITERATIONS = 600_000;
const LEGACY_ITERATIONS = 100_000;

// New format: pbkdf2$<iterations>$<salt>$<hash>
// Legacy format: <salt>:<hash>   (always 100k)
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomUUID().replace(/-/g, "");
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

type ParsedHash = { salt: string; hash: string; iterations: number };

function parseStored(stored: string): ParsedHash | null {
  if (stored.startsWith("pbkdf2$")) {
    const [, iterations, salt, hash] = stored.split("$");
    const n = parseInt(iterations, 10);
    if (!salt || !hash || !Number.isFinite(n) || n <= 0) return null;
    return { salt, hash, iterations: n };
  }
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return null;
  return { salt, hash, iterations: LEGACY_ITERATIONS };
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parsed = parseStored(stored);
  // A malformed or truncated hash must fail closed, not throw — a corrupt row
  // used to reach `undefined.length` inside the comparison and 500.
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(actual, parsed.hash);
}

// True when the stored hash is below the current cost and should be replaced
// on the next successful login.
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  return !parsed || parsed.iterations < PBKDF2_ITERATIONS;
}

export function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

// Session tokens are stored as a SHA-256 digest, so a leaked database snapshot
// (a backup, a D1 export, a stray console) is not a pile of usable credentials.
// A plain digest with no salt is deliberate and sufficient here: the input is
// 244 bits of CSPRNG output, so there is nothing to brute-force or rainbow —
// unlike a password, which is why that path uses PBKDF2 instead.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return bufToHex(new Uint8Array(digest));
}

async function derive(
  password: string,
  salt: string,
  iterations: number
): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );
  const buf = await crypto.subtle.exportKey("raw", key);
  return bufToHex(new Uint8Array(buf));
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
