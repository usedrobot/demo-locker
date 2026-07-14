#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2), { input: process.stdin, output: process.stdout }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
