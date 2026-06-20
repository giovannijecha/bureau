import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProvision, provision } from "../src/provision.js";
import type { CommandResult } from "@bureau/capabilities";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bureau-prov-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const write = (name: string, content = ""): void => writeFileSync(join(dir, name), content);

const OK: CommandResult = { stdout: "added 120 packages", stderr: "", code: 0, timedOut: false };

describe("detectProvision", () => {
  it("detects bun from a binary lockfile", () => {
    write("package.json", "{}");
    write("bun.lockb");
    expect(detectProvision(dir)).toEqual({ stack: "bun", command: ["bun", "install"] });
  });

  it("detects bun from package.json scripts even without a committed lockfile (the Dante case)", () => {
    write("package.json", JSON.stringify({ scripts: { start: "bun --preload @opentui/solid/preload src/index.ts" } }));
    expect(detectProvision(dir)).toEqual({ stack: "bun", command: ["bun", "install"] });
  });

  it("detects bun from a packageManager field", () => {
    write("package.json", JSON.stringify({ packageManager: "bun@1.1.0" }));
    expect(detectProvision(dir)?.stack).toBe("bun");
  });

  it("prefers pnpm (frozen) by lockfile", () => {
    write("package.json", "{}");
    write("pnpm-lock.yaml");
    expect(detectProvision(dir)?.command).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("uses npm ci with a package-lock", () => {
    write("package.json", "{}");
    write("package-lock.json");
    expect(detectProvision(dir)?.command).toEqual(["npm", "ci"]);
  });

  it("falls back to npm install with a bare package.json", () => {
    write("package.json", "{}");
    expect(detectProvision(dir)).toEqual({ stack: "npm", command: ["npm", "install"] });
  });

  it("detects go, cargo, pip, and bundler", () => {
    write("go.mod", "module x");
    expect(detectProvision(dir)?.command).toEqual(["go", "mod", "download"]);
    rmSync(join(dir, "go.mod"));
    write("Cargo.toml", "[package]");
    expect(detectProvision(dir)?.command).toEqual(["cargo", "fetch"]);
    rmSync(join(dir, "Cargo.toml"));
    write("requirements.txt", "flask");
    expect(detectProvision(dir)?.command).toEqual(["pip", "install", "-r", "requirements.txt"]);
    rmSync(join(dir, "requirements.txt"));
    write("Gemfile", "gem 'rails'");
    expect(detectProvision(dir)?.command).toEqual(["bundle", "install"]);
  });

  it("returns null when no recognized manifest exists", () => {
    write("README.md", "# just docs");
    expect(detectProvision(dir)).toBeNull();
  });

  it("survives a malformed package.json (no bun signal, falls back to npm)", () => {
    write("package.json", "{ not json");
    expect(detectProvision(dir)).toEqual({ stack: "npm", command: ["npm", "install"] });
  });
});

describe("provision", () => {
  it("skips (ok, never spawns) when no stack is detected", async () => {
    let calls = 0;
    const r = await provision(dir, { runner: async () => (calls++, OK) });
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("runs the detected install and reports ok with the stack", async () => {
    write("package.json", "{}");
    write("bun.lockb");
    let seen: readonly string[] = [];
    const r = await provision(dir, { runner: async (argv) => ((seen = argv), OK) });
    expect(seen).toEqual(["bun", "install"]);
    expect(r).toMatchObject({ skipped: false, ok: true, stack: "bun" });
  });

  it("reports ok:false (NOT skipped) on a failed install, keeping the output", async () => {
    write("package.json", "{}");
    const r = await provision(dir, {
      runner: async () => ({ stdout: "", stderr: "npm ERR! network ECONNREFUSED", code: 1, timedOut: false }),
    });
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("ECONNREFUSED");
  });

  it("reports ok:false on a spawn failure (code -1)", async () => {
    write("package.json", "{}");
    write("bun.lockb");
    const r = await provision(dir, {
      runner: async () => ({ stdout: "", stderr: "spawn bun ENOENT", code: -1, timedOut: false }),
    });
    expect(r.ok).toBe(false);
  });

  it("honors a CEO override command over auto-detection", async () => {
    write("package.json", "{}");
    write("package-lock.json"); // detection would pick npm ci
    let seen: readonly string[] = [];
    const r = await provision(dir, { override: ["bun", "install"], runner: async (argv) => ((seen = argv), OK) });
    expect(seen).toEqual(["bun", "install"]);
    expect(r.ok).toBe(true);
  });
});
