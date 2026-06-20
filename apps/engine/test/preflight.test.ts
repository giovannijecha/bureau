import { describe, it, expect } from "vitest";

import { runPreflight } from "../src/preflight.js";
import type { CommandRunner } from "@bureau/capabilities";

// A fake runner keyed by program name: -1 ⇒ ENOENT (not spawnable); default 0 ⇒ spawnable.
const runnerFrom =
  (codes: Record<string, number>): CommandRunner =>
  async (argv) => ({ stdout: "", stderr: "", code: codes[argv[0]!] ?? 0, timedOut: false });

const ALL_OK = runnerFrom({});

const base = {
  paths: {
    db: "/home/u/.bureau-data/bureau.db",
    reposRoot: "/home/u/.bureau-data/repos",
    vault: "/home/u/.bureau-data/vault",
  },
  gitPath: "git",
  ghPath: "gh",
  cwd: "/home/u/bureau/apps/engine",
  log: () => {},
};

describe("runPreflight", () => {
  it("passes a healthy WSL setup — all tools spawnable, native data paths, no warnings", async () => {
    const r = await runPreflight({ ...base, isWsl: true, runner: ALL_OK });
    expect(r.ok).toBe(true);
    expect(r.fatal).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.toolchain.git).toBe(true);
    expect(r.toolchain.bun).toBe(true);
  });

  it("FATAL when a data path is on the WSL /mnt mount (SQLite WAL on 9p corrupts)", async () => {
    const r = await runPreflight({
      ...base,
      isWsl: true,
      runner: ALL_OK,
      paths: { db: "/mnt/c/Users/u/bureau.db", reposRoot: "/home/u/.bureau-data/repos", vault: "/home/u/.bureau-data/vault" },
    });
    expect(r.ok).toBe(false);
    expect(r.fatal.join("\n")).toMatch(/BUREAU_DB.*\/mnt/);
  });

  it("does NOT enforce /mnt off-WSL (a real Linux box may mount /mnt legitimately)", async () => {
    const r = await runPreflight({
      ...base,
      isWsl: false,
      runner: ALL_OK,
      paths: { db: "/mnt/data/bureau.db", reposRoot: "/mnt/data/repos", vault: "/mnt/data/vault" },
    });
    expect(r.ok).toBe(true);
    expect(r.fatal).toEqual([]);
  });

  it("FATAL when git is not spawnable (the substrate of every task)", async () => {
    const r = await runPreflight({ ...base, isWsl: true, runner: runnerFrom({ git: -1 }) });
    expect(r.ok).toBe(false);
    expect(r.fatal.join("\n")).toMatch(/git.*not spawnable/);
  });

  it("probes the CONFIGURED git program (BUREAU_GIT_PATH)", async () => {
    const r = await runPreflight({ ...base, gitPath: "/usr/bin/git", isWsl: true, runner: runnerFrom({ "/usr/bin/git": -1 }) });
    expect(r.ok).toBe(false);
    expect(r.fatal.join("\n")).toMatch(/\/usr\/bin\/git.*not spawnable/);
  });

  it("WARNS (never fatal) when gh or a provisioning stack tool is missing", async () => {
    const r = await runPreflight({ ...base, isWsl: true, runner: runnerFrom({ gh: -1, bun: -1, cargo: -1 }) });
    expect(r.ok).toBe(true); // the engine still serves
    const w = r.warnings.join("\n");
    expect(w).toMatch(/gh.*not spawnable/);
    expect(w).toMatch(/bun/);
    expect(w).toMatch(/cargo/);
    expect(r.toolchain.bun).toBe(false);
    expect(r.toolchain.pnpm).toBe(true);
  });

  it("treats a timed-out probe as spawnable — a hung-but-real git must not false-FATAL", async () => {
    // git resolves but hangs → runner kills it (code -1 with timedOut). It DID start, so it's present.
    const slowGit: CommandRunner = async (argv) =>
      argv[0] === "git"
        ? { stdout: "", stderr: "", code: -1, timedOut: true }
        : { stdout: "", stderr: "", code: 0, timedOut: false };
    const r = await runPreflight({ ...base, isWsl: true, runner: slowGit });
    expect(r.toolchain.git).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.fatal).toEqual([]);
  });

  it("WARNS on a relative data path under WSL (it follows the launch dir)", async () => {
    const r = await runPreflight({
      ...base,
      isWsl: true,
      runner: ALL_OK,
      paths: { db: "./bureau.db", reposRoot: "/home/u/.bureau-data/repos", vault: "/home/u/.bureau-data/vault" },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/BUREAU_DB.*relative/);
  });

  it("logs the PATH and the spawnable set", async () => {
    const lines: string[] = [];
    await runPreflight({ ...base, isWsl: true, runner: ALL_OK, log: (m) => lines.push(m) });
    expect(lines.some((l) => l.startsWith("[preflight] PATH="))).toBe(true);
    expect(lines.some((l) => l.includes("spawnable:"))).toBe(true);
  });
});
