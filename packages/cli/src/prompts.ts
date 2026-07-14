import { createInterface } from "node:readline/promises";
import type { IO } from "./main.js";

export async function ask(io: IO, question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const suffix = def !== undefined ? ` [${def}]` : "";
    const answer = (await rl.question(`${question}${suffix} `)).trim();
    return answer !== "" ? answer : (def ?? "");
  } finally {
    rl.close();
  }
}

export async function select<T extends string>(
  io: IO,
  question: string,
  choices: { value: T; label: string }[],
  def: T,
): Promise<T> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    io.output.write(`${question}\n`);
    choices.forEach((c, i) => {
      const marker = c.value === def ? "*" : " ";
      io.output.write(`  ${i + 1})${marker}${c.label} (${c.value})\n`);
    });
    // Use async iteration instead of repeated rl.question() calls: readline
    // Interfaces are async iterables that internally buffer 'line' events, so
    // a line arriving between one question resolving and the next being
    // registered is never lost (unlike calling rl.question() in a loop, where
    // there's a listener-less gap that can drop back-to-back/piped input).
    io.output.write(`> [${def}] `);
    for await (const line of rl) {
      const raw = line.trim();
      if (raw === "") return def;
      const byNumber = choices[Number(raw) - 1];
      if (byNumber) return byNumber.value;
      const byValue = choices.find((c) => c.value === raw);
      if (byValue) return byValue.value;
      io.output.write(`Please answer 1-${choices.length} or a listed value.\n`);
      io.output.write(`> [${def}] `);
    }
    return def;
  } finally {
    rl.close();
  }
}
