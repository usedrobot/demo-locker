import { PassThrough } from "node:stream";

export function fakeIO() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (c) => (text += c.toString()));
  return { io: { input, output }, read: () => text, write: (s: string) => input.write(s) };
}

/**
 * Poll `read()` until its accumulated text contains `substring`, or reject
 * after `timeoutMs`. Used to sequence writes to a fakeIO input stream so
 * each answer is sent only after the prompt it answers has actually been
 * printed — see the comment at its call site in questions.test.ts for why
 * that matters (cross-prompt type-ahead into readline is unsupported).
 */
export async function waitForOutput(
  read: () => string,
  substring: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!read().includes(substring)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for output to contain: ${JSON.stringify(substring)}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}
