import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags, detectContext, collectAnswers } from "../src/questions.js";
import { fakeIO, waitForOutput } from "./helpers.js";

describe("parseFlags", () => {
  it("parses all long flags", () => {
    const f = parseFlags([
      "--mode", "instance", "--target", "docker", "--storage", "s3",
      "--port", "4000", "--volume", "bandstuff",
      "--s3-endpoint", "https://x.r2.cloudflarestorage.com",
      "--s3-bucket", "demos", "--s3-access-key", "AK", "--s3-secret-key", "SK",
      "--email", "dl@fldl.space", "--password", "hunter22",
      "--yes", "--dry-run",
    ]);
    expect(f.mode).toBe("instance");
    expect(f.port).toBe("4000");
    expect(f.yes).toBe(true);
    expect(f.dryRun).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(() => parseFlags(["--mode", "banana"])).toThrow(/mode/);
  });

  it("rejects non-integer port", () => {
    expect(() => parseFlags(["--port", "abc"])).toThrow(/--port/);
  });

  it("rejects a --url with no scheme", () => {
    expect(() => parseFlags(["--url", "demos.example.com"])).toThrow(/scheme/);
  });

  it("accepts a --url with http:// scheme", () => {
    const f = parseFlags(["--url", "http://192.168.1.10:3001"]);
    expect(f.url).toBe("http://192.168.1.10:3001");
  });

  it("accepts a --url with https:// scheme", () => {
    const f = parseFlags(["--url", "https://demos.example.com"]);
    expect(f.url).toBe("https://demos.example.com");
  });

  it("rejects port outside valid range", () => {
    expect(() => parseFlags(["--port", "65536"])).toThrow(/--port/);
    expect(() => parseFlags(["--port", "0"])).toThrow(/--port/);
  });
});

describe("detectContext", () => {
  it("web-project when package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    writeFileSync(join(dir, "package.json"), "{}");
    expect(detectContext(dir)).toBe("web-project");
  });
  it("empty otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    expect(detectContext(dir)).toBe("empty");
  });
});

describe("collectAnswers", () => {
  it("fully non-interactive with flags + --yes (docker/local)", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "local", "--yes"]);
    const a = await collectAnswers(flags, io, "empty");
    expect(a).toMatchObject({
      mode: "instance", target: "docker", storage: "local",
      port: 3001, volume: "demolocker", s3: null, signup: null, url: null,
    });
  });

  it("player mode with --url skips instance questions", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "player", "--url", "https://demos.fldl.space", "--yes"]);
    const a = await collectAnswers(flags, io, "web-project");
    expect(a.target).toBeNull();
    expect(a.storage).toBeNull();
    expect(a.url).toBe("https://demos.fldl.space");
  });

  it("defaults mode by context: web-project → both, empty → instance", async () => {
    const { io } = fakeIO();
    const a1 = await collectAnswers(parseFlags(["--yes", "--target", "docker"]), io, "web-project");
    expect(a1.mode).toBe("both");
    const a2 = await collectAnswers(parseFlags(["--yes"]), io, "empty");
    expect(a2.mode).toBe("instance");
  });

  it("s3 storage requires the s3 flags in --yes mode", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "s3", "--yes"]);
    await expect(collectAnswers(flags, io, "empty")).rejects.toThrow(/--s3-endpoint/);
  });

  it("rejects --url with --target docker", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--url", "https://x", "--yes"]);
    await expect(collectAnswers(flags, io, "empty")).rejects.toThrow(/--url/);
  });

  it("rejects --url with --target cloudflare", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "cloudflare", "--url", "https://x", "--yes"]);
    await expect(collectAnswers(flags, io, "empty")).rejects.toThrow(/--url/);
  });

  it("allows --url with --target existing", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "existing", "--url", "https://demos.example.com", "--yes"]);
    const a = await collectAnswers(flags, io, "empty");
    expect(a.target).toBe("existing");
    expect(a.url).toBe("https://demos.example.com");
  });

  it("interactive path walks the tree", async () => {
    const { io, write, read } = fakeIO();
    const flags = parseFlags([]);
    const p = collectAnswers(flags, io, "empty");

    // Cross-prompt type-ahead is unsupported: ask()/select() each open and
    // close their own readline interface, and select() consumes lines via
    // async iteration internally. A line written for a later prompt while an
    // earlier prompt's interface is still open can be swallowed and lost
    // when that interface closes. Real humans type after seeing each prompt;
    // scripted callers use flags. So here we wait for each prompt's text to
    // actually appear in the output before writing its answer, rather than
    // writing all answers synchronously up front.
    await waitForOutput(read, "What do you need?");
    write("1\n"); // mode: instance
    await waitForOutput(read, "Where will it run?");
    write("2\n"); // target: docker (option 1 is cloudflare, 3 is existing)
    await waitForOutput(read, "Where should audio files live?");
    write("1\n"); // storage: local
    await waitForOutput(read, "Host port?");
    write("\n"); // port: default 3001
    await waitForOutput(read, "Docker volume name");
    write("\n"); // volume: default demolocker
    await waitForOutput(read, "Create the first account now?");
    write("\n"); // email: empty → skip signup

    const a = await p;
    expect(a.mode).toBe("instance");
    expect(a.signup).toBeNull();
  });

  it("rejects a --password under 8 characters", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "local", "--email", "dl@fldl.space", "--password", "short", "--yes"]);
    await expect(collectAnswers(flags, io, "empty")).rejects.toThrow(/--password must be at least 8 characters/);
  });

  it("rejects --target when --mode player is used with --url", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "player", "--url", "https://demos.fldl.space", "--target", "docker", "--yes"]);
    await expect(collectAnswers(flags, io, "web-project")).rejects.toThrow(/--target/);
  });

  it("interactive port validation re-asks on invalid input", async () => {
    const { io, write, read } = fakeIO();
    const flags = parseFlags([]);
    const p = collectAnswers(flags, io, "empty");

    await waitForOutput(read, "What do you need?");
    write("1\n"); // mode: instance
    await waitForOutput(read, "Where will it run?");
    write("2\n"); // target: docker (option 1 is cloudflare, 3 is existing)
    await waitForOutput(read, "Where should audio files live?");
    write("1\n"); // storage: local
    await waitForOutput(read, "Host port?");
    write("abc\n"); // invalid port
    await waitForOutput(read, "Please enter an integer 1-65535"); // re-ask message
    write("8080\n"); // valid port
    await waitForOutput(read, "Docker volume name");
    write("\n"); // volume: default demolocker
    await waitForOutput(read, "Create the first account now?");
    write("\n"); // email: empty → skip signup

    const a = await p;
    expect(a.port).toBe(8080);
  });

  it("pins the docker interactive prompt order (mode, target, storage, port, volume, signup)", async () => {
    const { io, write, read } = fakeIO();
    const flags = parseFlags([]);
    const p = collectAnswers(flags, io, "empty");

    const order: string[] = [];
    const markers = [
      "What do you need?",
      "Where will it run?",
      "Where should audio files live?",
      "Host port?",
      "Docker volume name",
      "Create the first account now?",
    ];
    const answers = ["1\n", "2\n", "1\n", "\n", "\n", "\n"];

    for (let i = 0; i < markers.length; i++) {
      await waitForOutput(read, markers[i]);
      order.push(markers[i]);
      write(answers[i]);
    }

    await p;
    expect(order).toEqual(markers);
  });
});

describe("cloudflare flags", () => {
  it("--yes fills cloudflare defaults with no domain", async () => {
    const { io } = fakeIO();
    const a = await collectAnswers(
      parseFlags(["--mode", "instance", "--target", "cloudflare", "--yes"]),
      io,
      "empty",
    );
    expect(a.cloudflare).toEqual({
      workerName: "demo-locker",
      d1Name: "demo-locker-db",
      r2Bucket: "demo-locker-demos",
      domain: null,
    });
    expect(a.storage).toBeNull();
  });

  it("accepts explicit cloudflare flags", async () => {
    const { io } = fakeIO();
    const a = await collectAnswers(
      parseFlags([
        "--mode", "instance", "--target", "cloudflare", "--yes",
        "--worker-name", "dl", "--d1-name", "dl-db",
        "--r2-bucket", "dl-demos", "--domain", "demolocker.dlisok.com",
      ]),
      io,
      "empty",
    );
    expect(a.cloudflare).toEqual({
      workerName: "dl", d1Name: "dl-db",
      r2Bucket: "dl-demos", domain: "demolocker.dlisok.com",
    });
  });

  it("rejects a --domain that is a URL rather than a hostname", () => {
    expect(() => parseFlags(["--domain", "https://demolocker.dlisok.com"]))
      .toThrow(/bare hostname/);
  });

  it("rejects --domain on a non-cloudflare target", async () => {
    const { io } = fakeIO();
    await expect(
      collectAnswers(
        parseFlags(["--mode", "instance", "--target", "docker", "--domain", "x.example.com", "--yes"]),
        io,
        "empty",
      ),
    ).rejects.toThrow(/only valid with --target cloudflare/);
  });

  it("lowercases the domain, since it lands in routes, URLs, and the embed snippet", async () => {
    const { io } = fakeIO();
    const a = await collectAnswers(
      parseFlags(["--mode", "instance", "--target", "cloudflare", "--domain", "Demos.Example.COM", "--yes"]),
      io,
      "empty",
    );
    expect(a.cloudflare?.domain).toBe("demos.example.com");
  });

  it("rejects --port and --volume on the cloudflare target rather than ignoring them", async () => {
    const { io } = fakeIO();
    await expect(
      collectAnswers(
        parseFlags(["--mode", "instance", "--target", "cloudflare", "--port", "8080", "--yes"]),
        io,
        "empty",
      ),
    ).rejects.toThrow(/--port is not valid with --target cloudflare/);
    await expect(
      collectAnswers(
        parseFlags(["--mode", "instance", "--target", "cloudflare", "--volume", "vol", "--yes"]),
        io,
        "empty",
      ),
    ).rejects.toThrow(/--volume is not valid with --target cloudflare/);
  });

  it("rejects --email/--password on cloudflare with no domain, where there is no URL to sign up against", async () => {
    const { io } = fakeIO();
    await expect(
      collectAnswers(
        parseFlags([
          "--mode", "instance", "--target", "cloudflare", "--yes",
          "--email", "dl@fldl.space", "--password", "hunter22",
        ]),
        io,
        "empty",
      ),
    ).rejects.toThrow(/--domain/);
  });

  it("accepts --email/--password on cloudflare when a domain is given", async () => {
    const { io } = fakeIO();
    const a = await collectAnswers(
      parseFlags([
        "--mode", "instance", "--target", "cloudflare", "--domain", "demos.example.com",
        "--email", "dl@fldl.space", "--password", "hunter22", "--yes",
      ]),
      io,
      "empty",
    );
    expect(a.signup).toEqual({ email: "dl@fldl.space", password: "hunter22" });
  });

  it("interactive: re-asks on an invalid domain instead of throwing out of collectAnswers", async () => {
    const { io, write, read } = fakeIO();
    const p = collectAnswers(parseFlags([]), io, "empty");

    await waitForOutput(read, "What do you need?");
    write("1\n"); // mode: instance
    await waitForOutput(read, "Where will it run?");
    write("1\n"); // target: cloudflare
    await waitForOutput(read, "Custom domain?");
    write("https://demos.example.com\n"); // a URL, not a bare hostname
    await waitForOutput(read, "bare hostname");
    write("demos.example.com\n"); // valid this time
    // A domain means there IS a reachable URL, so the signup question is asked.
    await waitForOutput(read, "Create the first account now?");
    write("\n"); // email: empty → skip signup

    const a = await p;
    expect(a.cloudflare?.domain).toBe("demos.example.com");
  });

  it("interactive: a blank domain means workers.dev and skips the signup question entirely", async () => {
    const { io, write, read } = fakeIO();
    const p = collectAnswers(parseFlags([]), io, "empty");

    await waitForOutput(read, "What do you need?");
    write("1\n"); // mode: instance
    await waitForOutput(read, "Where will it run?");
    write("1\n"); // target: cloudflare
    await waitForOutput(read, "Custom domain?");
    write("\n"); // blank → workers.dev

    const a = await p;
    expect(a.cloudflare?.domain).toBeNull();
    expect(a.signup).toBeNull();
    // No reachable URL exists yet, so the wizard must not collect a credential
    // it would only throw away.
    expect(read()).not.toContain("Create the first account now?");
  });
});

describe("--upgrade flag", () => {
  it("parses as a boolean, defaulting false", () => {
    expect(parseFlags([]).upgrade).toBe(false);
    expect(parseFlags(["--upgrade"]).upgrade).toBe(true);
  });

  it("rejects install-only flags alongside --upgrade", () => {
    for (const bad of [
      ["--upgrade", "--mode", "instance"],
      ["--upgrade", "--storage", "local"],
      ["--upgrade", "--port", "3001"],
      ["--upgrade", "--volume", "demolocker"],
      // Silently ignored before: an upgrade neither points at a new URL nor
      // creates the first account.
      ["--upgrade", "--url", "https://demos.example.com"],
      ["--upgrade", "--email", "dl@fldl.space"],
    ]) {
      expect(() => parseFlags(bad), bad.join(" ")).toThrow(/--upgrade/);
    }
  });

  it("allows the naming flags as overrides", () => {
    const f = parseFlags([
      "--upgrade", "--worker-name", "w", "--d1-name", "d",
      "--r2-bucket", "r", "--domain", "h.co", "--target", "cloudflare",
    ]);
    expect(f.upgrade).toBe(true);
    expect(f.workerName).toBe("w");
    expect(f.d1Name).toBe("d");
    expect(f.r2Bucket).toBe("r");
    expect(f.domain).toBe("h.co");
  });
});
