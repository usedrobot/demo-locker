import { PassThrough } from "node:stream";

export function fakeIO() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (c) => (text += c.toString()));
  return { io: { input, output }, read: () => text, write: (s: string) => input.write(s) };
}
