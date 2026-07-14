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
    for (;;) {
      const raw = (await rl.question(`> [${def}] `)).trim();
      if (raw === "") return def;
      const byNumber = choices[Number(raw) - 1];
      if (byNumber) return byNumber.value;
      const byValue = choices.find((c) => c.value === raw);
      if (byValue) return byValue.value;
      io.output.write(`Please answer 1-${choices.length} or a listed value.\n`);
    }
  } finally {
    rl.close();
  }
}
