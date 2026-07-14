import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "./main.js";
import type { Runner } from "./execute.js";

export function embedSnippets(instanceUrl: string): { scriptTag: string; npmModule: string } {
  const base = instanceUrl.replace(/\/$/, "");
  return {
    scriptTag: `<script src="${base}/embed.js"></script>
<demo-locker-player playlist="YOUR_PLAYLIST_ID"></demo-locker-player>`,
    npmModule: `import "@demo-locker/player";
// then in your markup:
// <demo-locker-player instance="${base}" playlist="YOUR_PLAYLIST_ID"></demo-locker-player>`,
  };
}

export async function setupPlayer(
  instanceUrl: string,
  cwd: string,
  io: IO,
  runner: Runner,
): Promise<number> {
  const snippets = embedSnippets(instanceUrl);
  const inProject = existsSync(join(cwd, "package.json"));

  if (inProject) {
    io.output.write("→ installing @demo-locker/player\n");
    const code = await runner.exec("npm", ["install", "@demo-locker/player"]);
    if (code !== 0) {
      io.output.write("✗ npm install failed\n");
      return 1;
    }
    io.output.write(`\nAdd the player to your app:\n\n${snippets.npmModule}\n`);
  } else {
    io.output.write(`\nDrop this into any HTML page:\n\n${snippets.scriptTag}\n`);
  }
  io.output.write(
    "\nOnly playlists marked public are embeddable — toggle that in the Demo Locker UI,\nthen replace YOUR_PLAYLIST_ID with the playlist's ID.\n",
  );
  return 0;
}
