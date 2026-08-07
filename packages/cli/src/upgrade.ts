// Upgrading an instance that already exists. Creates nothing.

import { join } from "node:path";
import { PACKAGED_ASSETS_FOR_UPGRADE, cliVersion, versionedImage, wranglerConfig } from "./plan.js";
import type { DeployPlan, Step } from "./plan.js";
import type { DiscoveredInstance } from "./discover.js";

export interface UpgradeOptions {
  /**
   * The image tag to move a docker instance to. Defaults to this CLI's own
   * version — see versionedImage(). main.ts passes `:latest` when the
   * versioned tag is not published.
   */
  image?: string;
}

// ---------------------------------------------------------------------------
// The MAX_COLLABORATORS meaning change (0.2.13)
//
// It used to cap share links per playlist; it now caps collaborator seats, and
// MAX_SHARE_LINKS took over the old job. Upgrade re-passes the operator's env
// verbatim, so an upgrade across that boundary is the moment their setting
// silently starts doing something else — and the only moment we can say so
// outside release notes.
//
// The notice is narrowly targeted, because a misfire is worse than silence:
// telling someone already on the new meaning to move their value to
// MAX_SHARE_LINKS would install a per-playlist cap they never wanted and start
// 403ing share creation. Hence the three gates below, and the two wordings.
//
// The wording matters as much as the gating. Nothing here establishes what the
// operator *meant* by MAX_COLLABORATORS — only that they set it. So even the
// definite form says "if you set it to limit share links, move the value",
// matching docs/self-hosting.md, rather than instructing them to move it.
// ---------------------------------------------------------------------------

/** The release in which MAX_COLLABORATORS stopped meaning "share links". */
export const RENAME_VERSION: readonly number[] = [0, 2, 13];

/**
 * Past this, the rename is old news and an undirected pointer is just noise.
 * Anyone still crossing the boundary by then has skipped the whole 0.3 line,
 * and docs/upgrading.md keeps the instructions regardless. Used only for the
 * Cloudflare notice, which cannot be targeted any other way.
 */
export const RENAME_NOTICE_SUNSET: readonly number[] = [0, 4, 0];

/** `"0.2.10"` → `[0, 2, 10]`; null if it is not a semantic version. */
export function parseVersion(text: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric, not lexical — 0.10.0 is after 0.2.13, not before it. */
function isBefore(v: readonly number[], than: readonly number[]): boolean {
  for (let i = 0; i < than.length; i++) {
    if (v[i]! !== than[i]!) return v[i]! < than[i]!;
  }
  return false;
}

/**
 * The semantic version in a docker image reference, or null when it cannot be
 * read — `:latest`, a digest pin, or no tag at all.
 *
 * Splits on the last path segment first so a registry host with a port
 * (`localhost:5000/demo-locker:0.2.10`) does not read as a tag.
 */
export function imageVersion(image: string): number[] | null {
  const ref = image.split("/").pop() ?? "";
  const tag = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : "";
  return parseVersion(tag);
}

/**
 * Is this instance old enough to be affected?
 *
 * Null (unknown) is NOT treated as "yes" — see renameNotes. `:latest` is the
 * documented install and upgrade tag (README.md:52, docs/upgrading.md:69) and
 * main.ts falls back to it whenever the registry cannot be reached, so
 * unknown is a large share of live installs and stays unknown forever. What
 * unknown gets is a weaker, non-directive wording, not a guess.
 */
export function predatesRename(image: string): boolean {
  const v = imageVersion(image);
  return v !== null && isBefore(v, RENAME_VERSION);
}

/** The value of `NAME=value` in a docker-style env list, or null if absent. */
function envValue(env: readonly string[], name: string): string | null {
  const hit = env.find((e) => e.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export function renameNotes(env: readonly string[], image: string): Step[] {
  // Gate 1 — was a cap actually in force? getLimits treats unset, empty and
  // "0" identically (isLimited is `limit > 0`), so an empty or zero value
  // never capped anything and there is nothing to tell the operator about.
  const configured = Number.parseInt(envValue(env, "MAX_COLLABORATORS") ?? "", 10);
  if (!(configured > 0)) return [];

  // Gate 2 — have they already migrated? MAX_SHARE_LINKS is preserved across
  // upgrades like any other app var, so its presence is the clearest signal
  // available that this operator has seen the new variable and chosen values
  // for both deliberately. Repeating the advice would talk them into
  // overwriting a deliberate choice. Presence, not `> 0`, on purpose: the
  // question here is "have they encountered this variable", not "is a cap in
  // force" — someone who set it to 0 to mean unlimited has still migrated.
  if (envValue(env, "MAX_SHARE_LINKS") !== null) return [];

  // Gate 3 — are they crossing the boundary?
  //
  // Three outcomes, not two. An instance demonstrably on 0.2.13+ is silent: it
  // set MAX_COLLABORATORS under the current meaning, deliberately, as a seat
  // cap, and must not be nudged into moving it.
  const from = imageVersion(image);
  if (from !== null && !isBefore(from, RENAME_VERSION)) return [];

  const changed = {
    kind: "note" as const,
    text: "note: MAX_COLLABORATORS is set on this instance, and it changed meaning in 0.2.13.",
  };
  // Shared by both wordings: what the variable means now. Split across two
  // lines so it does not wrap in an 80-column terminal.
  const nowMeans: Step[] = [
    {
      kind: "note",
      text: "  It caps collaborators — people who sign in and share your library.",
    },
    { kind: "note", text: "  Share links per playlist are capped by MAX_SHARE_LINKS." },
  ];

  // Unknown version. `:latest` is the documented install and upgrade tag, and
  // main.ts falls back to it whenever the registry cannot be reached, so this
  // is a large share of installs — and it never resolves, because the new
  // container carries the same unreadable tag next time.
  //
  // So it gets the facts and no instruction. An operator on 0.3.1-as-:latest
  // who set a deliberate seat cap and wants unlimited share links reaches this
  // branch, and "move the value to MAX_SHARE_LINKS" would hand them a cap that
  // 403s their share creation — the exact harm the gates exist to prevent. The
  // same reasoning as the Cloudflare path below: state it conditionally, and
  // let the docs carry the instruction to whoever it actually applies to.
  if (from === null) {
    return [
      changed,
      ...nowMeans,
      {
        kind: "note",
        text: "  This instance's version could not be read from its image tag; if it predates 0.2.13,",
      },
      { kind: "note", text: "  see docs/upgrading.md." },
    ];
  }

  // Known to predate the rename. Even here the gates establish only that a cap
  // was set, never that it was meant as a share-link cap — someone who set it
  // as a seat cap and never made a share link would gain a ceiling they never
  // had. So this stays conditional too, phrased as docs/self-hosting.md does.
  return [
    changed,
    ...nowMeans,
    {
      kind: "note",
      text: "  If you set MAX_COLLABORATORS to limit share links, move the value there.",
    },
    { kind: "note", text: "  See docs/upgrading.md." },
  ];
}

/**
 * The Cloudflare pointer. Unconditional in content, because a Worker's vars
 * live in the dashboard: no read-only wrangler command reports them, so
 * CloudflareCandidate carries neither env nor a deployed version and there is
 * nothing to condition on. Worded so it says nothing false to an operator who
 * never set the variable.
 *
 * Bounded in time, though. "Undetectable" justifies printing it while the
 * boundary is plausibly still being crossed — not narrating a 0.2.13 change
 * during a 1.4.0 upgrade years later. Gated on the version being installed,
 * which is the one version this code does know.
 */
export function cloudflareRenameNotes(version: string = cliVersion()): Step[] {
  const v = parseVersion(version);
  if (v !== null && !isBefore(v, RENAME_NOTICE_SUNSET)) return [];
  return [
    {
      kind: "note",
      text: "note: if this instance sets MAX_COLLABORATORS, its meaning changed in 0.2.13.",
    },
    {
      kind: "note",
      text: "  It now caps collaborators; MAX_SHARE_LINKS caps share links per playlist.",
    },
    { kind: "note", text: "  See docs/upgrading.md." },
  ];
}

export function buildUpgradePlan(
  instance: DiscoveredInstance,
  stagingDir: string,
  opts: UpgradeOptions = {},
): DeployPlan {
  return instance.target === "docker"
    ? dockerUpgrade(instance, opts.image ?? versionedImage())
    : cloudflareUpgrade(instance, stagingDir);
}

function cloudflareUpgrade(
  cf: Extract<DiscoveredInstance, { target: "cloudflare" }>,
  stagingDir: string,
): DeployPlan {
  // All three guards below must run before a single step is built: cloudflareUpgrade
  // substitutes these values straight into wrangler.jsonc, and by the time
  // `migrations apply` has run against the live D1, it is too late to back out.
  if (!cf.d1Id) {
    throw new Error(
      `internal error: cannot upgrade "${cf.d1Name}" — no D1 database id was resolved for it. ` +
        `This is a bug in discovery, not something a flag can work around.`,
    );
  }
  if (!cf.r2Bucket) {
    throw new Error(
      `cannot upgrade "${cf.workerName}": no R2 bucket named "${cf.workerName}-demos" (or matching ` +
        `--r2-bucket) could be found on this account. Fix the bucket first, or pass --r2-bucket <name>.`,
    );
  }
  // Discovery can't yet learn a Worker's custom domain (no read-only wrangler
  // command reports it — see task-7-report.md). Without a known domain this
  // function cannot emit a `routes` block, and Cloudflare's default for a
  // routes-less config is to enable workers.dev for the deploy — silently
  // giving what may be a private instance a second, public URL. Refusing and
  // naming the fix is safer than an upgrade that "succeeds" by exposing it.
  if (!cf.domain) {
    throw new Error(
      `cannot upgrade "${cf.workerName}": no custom domain is known for this instance. Deploying without ` +
        `one would omit its routes, and Cloudflare enables workers.dev by default for a routes-less config — ` +
        `that would publish this instance at a second, public *.workers.dev URL alongside its real domain. ` +
        `Pass --domain <host> naming the instance's actual custom domain and re-run the upgrade.`,
    );
  }

  const config = wranglerConfig({
    workerName: cf.workerName,
    d1Name: cf.d1Name,
    r2Bucket: cf.r2Bucket,
    domain: cf.domain,
    // Belt-and-suspenders alongside `routes` above — see the comment on
    // wranglerConfig's workersDev param.
    workersDev: false,
  }).replace("__DATABASE_ID__", cf.d1Id);

  const configPath = join(stagingDir, "wrangler.jsonc");
  const steps: Step[] = [
    // See cloudflareRenameNotes: undetectable here, so unconditional in
    // content, conditional in wording, and sunset by version.
    ...cloudflareRenameNotes(),
    { kind: "copy", title: "Stage the new build", from: PACKAGED_ASSETS_FOR_UPGRADE, to: stagingDir },
    { kind: "write", title: "Write wrangler config for this instance", path: configPath, contents: config },
    // MUST precede deploy: the ORM selects every column explicitly, so a Worker
    // running ahead of its migration breaks every read of any table that
    // gained a column. Asserted by a test, not left to step order by luck.
    {
      kind: "run",
      title: "Apply migrations",
      cmd: "npx",
      args: ["wrangler", "d1", "migrations", "apply", cf.d1Name, "--remote", "--config", configPath],
    },
    // The exit code of `migrations apply` does NOT mean "migrated". It prompts
    // ("About to apply N migration(s) … continue?") and answering "n" takes a
    // bare `return` — exit 0, nothing applied. It also exits 0 if a statement
    // comes back unsuccessful without throwing. Since the interactive path is
    // the human default, the only trustworthy check is to ask again: re-run
    // the read-only list and refuse to deploy while anything is still pending.
    // Fails closed — unrecognised output stops the deploy too.
    {
      kind: "run-assert",
      title: "Verify no migrations are still pending",
      cmd: "npx",
      args: ["wrangler", "d1", "migrations", "list", cf.d1Name, "--remote", "--config", configPath],
      pattern: "No migrations to apply",
      failure:
        `migrations are still pending on "${cf.d1Name}" — refusing to deploy. A Worker running ahead of ` +
        `its migrations breaks every read of any table that gained a column. If you answered "n" to ` +
        `wrangler's confirm prompt, re-run the upgrade and answer "y"; otherwise apply them by hand with ` +
        `\`npx wrangler d1 migrations apply ${cf.d1Name} --remote\` and re-run. Nothing has been deployed.`,
    },
    {
      kind: "run",
      title: "Deploy the new version",
      cmd: "npx",
      args: ["wrangler", "deploy", "--config", configPath],
    },
  ];

  // cf.domain is guaranteed truthy here — the guard above refuses to build a
  // plan otherwise — so the health check always has a URL to poll.
  const appUrl = `https://${cf.domain}`;
  return { steps, healthUrl: `${appUrl}/health`, appUrl };
}

function dockerUpgrade(
  dk: Extract<DiscoveredInstance, { target: "docker" }>,
  image: string,
): DeployPlan {
  // Both guards run before a single step is built — by the time the old
  // container has been stopped, refusing is no longer free.
  if (!dk.containerName) {
    throw new Error(
      `cannot upgrade container ${dk.containerId}: docker reports no name for it, and a replacement ` +
        `has to be started under the same name. Recreate it by hand from \`docker inspect ${dk.containerId}\`.`,
    );
  }
  // Recreating a container attached to a user-defined network onto the default
  // bridge is not an upgrade — every peer that reaches it by container name
  // loses it. Preserving arbitrary HostConfig (extra ports, labels, links) is
  // out of scope; silently dropping it is not.
  if (dk.networkMode) {
    throw new Error(
      `cannot upgrade "${dk.containerName}": it is attached to the "${dk.networkMode}" network, and this ` +
        `upgrade would recreate it on the default bridge — losing that attachment, and with it every ` +
        `container that reaches it by name. Any extra published ports, labels or links would be lost too. ` +
        `Upgrade this one by hand: read \`docker inspect ${dk.containerId}\`, then stop/rename it and ` +
        `re-run \`docker run\` with the same flags and the new image (${image}).`,
    );
  }

  const envArgs = dk.env.flatMap((e) => ["-e", e]);
  const notes: Step[] = renameNotes(dk.env, dk.image);
  // `-p 127.0.0.1:8080:3001` is a deliberate "not on the LAN". Emitting the
  // two-part form instead would republish it on 0.0.0.0.
  const publish = dk.hostIp ? `${dk.hostIp}:${dk.port}:3001` : `${dk.port}:3001`;
  // Renaming rather than removing keeps the old container recoverable: if
  // `run` fails, or the new container never becomes healthy, the previous one
  // is still on disk under this name and can be renamed back and started.
  const preupgrade = `${dk.containerName}-preupgrade`;
  const steps: Step[] = [
    ...notes,

    { kind: "run", title: "Pull the new image", cmd: "docker", args: ["pull", image] },
    { kind: "run", title: "Stop the running container", cmd: "docker", args: ["stop", dk.containerId] },
    {
      kind: "run",
      title: `Set the old container aside as ${preupgrade}`,
      cmd: "docker",
      args: ["rename", dk.containerId, preupgrade],
    },
    {
      kind: "run",
      title: "Start the new container on the same volume",
      cmd: "docker",
      args: [
        "run", "-d", "--name", dk.containerName, "--restart", "unless-stopped",
        "-v", `${dk.volume}:/data`, "-p", publish,
        ...envArgs,
        image,
      ],
    },
  ];
  const appUrl = `http://localhost:${dk.port}`;
  return {
    steps,
    healthUrl: `${appUrl}/health`,
    appUrl,
    // The new container is running and holding both the name and the port by
    // the time this is printed, so it has to go before the old one can be
    // renamed back — `docker rename` would fail on the name conflict, and
    // `docker start` on the port. `rm -f` here is the FAILED NEW container,
    // never the volume: no -v, ever.
    rollbackHint:
      `docker rm -f ${dk.containerName} && ` +
      `docker rename ${preupgrade} ${dk.containerName} && ` +
      `docker start ${dk.containerName}`,
    // Only once the new container is serving. NEVER -v: that would delete the
    // volume holding every uploaded master.
    afterHealthySteps: [
      {
        kind: "run",
        title: `Remove the pre-upgrade container ${preupgrade}`,
        cmd: "docker",
        args: ["rm", preupgrade],
      },
    ],
  };
}
