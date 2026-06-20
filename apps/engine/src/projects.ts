// Projects — the GitHub repositories Bureau works on. Each project has its own
// canonical clone and worktrees directory; tasks run against the project the CEO
// selected in the Assistant. The registry is the single source of truth for which
// repos exist and where they live on disk.

import { join, resolve, sep } from "node:path";
import type { Project } from "@bureau/contracts";
import type { ProjectRow } from "@bureau/db";
import { parseGithubRepo } from "@bureau/vcs";
import { OrchestratorError } from "./errors.js";

export interface ProjectConfig {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  /** A `git clone`-able source (https/ssh/local path). */
  readonly url: string;
  readonly baseBranch: string;
  /** Canonical clone on disk. */
  readonly canonicalPath: string;
  /** Root under which this project's task worktrees live. */
  readonly worktreesDir: string;
  /** CEO-configured argv for the `test` worker (e.g. ["npm","test"]). Already
   *  tokenized — the runtime NEVER parses a string into a command. Undefined ⇒ the
   *  project has no test suite and a test step degrades to a skip. */
  readonly testCommand?: readonly string[];
  /** The post-edit verify loop's full check list — a list of argv commands (build, typecheck,
   *  test) run in order. When set it OVERRIDES `testCommand` for verification. Undefined ⇒ the
   *  loop falls back to `[testCommand]`. */
  readonly verifyCommands?: readonly (readonly string[])[];
  /** CEO override for the dependency-install command (argv). Undefined ⇒ auto-detect the stack. */
  readonly provisionCommand?: readonly string[];
}

/** A partial update to a project's mutable command fields. Each key is independently optional:
 *  PRESENT (even as null) ⇒ apply (null/empty clears); ABSENT ⇒ leave the current value. */
export interface ProjectConfigPatch {
  readonly testCommand?: readonly string[] | null;
  readonly verifyCommands?: readonly (readonly string[])[] | null;
  readonly provisionCommand?: readonly string[] | null;
}

/** Public, panel-facing view of a project (no urls or on-disk paths). */
export function toProjectDto(p: ProjectConfig): Project {
  return {
    id: p.id,
    owner: p.owner,
    name: p.name,
    baseBranch: p.baseBranch,
    ...(p.testCommand && p.testCommand.length > 0 ? { testCommand: [...p.testCommand] } : {}),
    ...(p.verifyCommands && p.verifyCommands.length > 0 ? { verifyCommands: p.verifyCommands.map((c) => [...c]) } : {}),
    ...(p.provisionCommand && p.provisionCommand.length > 0 ? { provisionCommand: [...p.provisionCommand] } : {}),
  };
}

export class ProjectRegistry {
  // Mutable IN PLACE: each snapshot is a readonly array, but the field is reassigned by
  // add/remove. The orchestrator + terminal hold THIS instance and call methods on it, so
  // a mutation propagates everywhere with zero rewiring — never construct a second registry.
  private projects: readonly ProjectConfig[];

  // May be empty: a fresh install boots with zero projects and the panel shows its
  // onboarding (add a repo from there). default()/resolve() then 409 until one exists.
  constructor(projects: readonly ProjectConfig[]) {
    const ids = new Set<string>();
    for (const p of projects) {
      if (ids.has(p.id)) throw new Error(`Duplicate project id: ${p.id}`);
      ids.add(p.id);
    }
    this.projects = projects;
  }

  list(): ProjectConfig[] {
    return [...this.projects];
  }

  /** The default project (the first one) — used when no project is specified. Throws a
   *  typed 409 when no project exists yet (a fresh install) so callers surface a clean
   *  "add a repository first" instead of crashing. */
  default(): ProjectConfig {
    const p = this.projects[0];
    if (!p) throw new OrchestratorError("No project configured — add a repository first.", 409);
    return p;
  }

  get(id: string): ProjectConfig {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new OrchestratorError(`Unknown project: ${id}`, 404);
    return p;
  }

  resolve(id: string | undefined): ProjectConfig {
    return id === undefined ? this.default() : this.get(id);
  }

  /** Resolve the project a task belongs to (by owner/name). */
  find(owner: string, name: string): ProjectConfig {
    const p = this.projects.find((x) => x.owner === owner && x.name === name);
    if (!p) throw new OrchestratorError(`No project configured for ${owner}/${name}`, 409);
    return p;
  }

  /** Apply a PARTIAL command-config patch to a project in place — the only MUTABLE fields of a
   *  config (everything else keys on-disk paths / identity). A field PRESENT in the patch is set
   *  (or cleared when null/empty); a field ABSENT is left untouched. Returns the new config and
   *  mutates the one shared array so every holder (orchestrator, terminal) sees it immediately. */
  setConfig(id: string, patch: ProjectConfigPatch): ProjectConfig {
    const idx = this.projects.findIndex((p) => p.id === id);
    if (idx < 0) throw new OrchestratorError(`Unknown project: ${id}`, 404);
    const cur = this.projects[idx]!;
    // Normalize + VALIDATE each command. The runtime PATCH path lands here, so the argv[0]-not-a-flag
    // argument-injection defense (mirroring parseTestCommand on the env-boot path) must run here too —
    // every command is later spawned through the shell-free runner with the CEO supplying the whole argv.
    const argv = (v: readonly string[] | null | undefined, field: string): readonly string[] | undefined => {
      if (!v || v.length === 0) return undefined;
      assertSafeArgv(v, field);
      return [...v];
    };
    const argvList = (
      v: readonly (readonly string[])[] | null | undefined,
      field: string
    ): readonly (readonly string[])[] | undefined =>
      v && v.length > 0 ? v.map((c, i) => argv(c, `${field}[${i}]`)!) : undefined;
    // For each command field: apply the patch when the key is present, else keep the current value.
    const testCommand = "testCommand" in patch ? argv(patch.testCommand, "testCommand") : cur.testCommand;
    const verifyCommands = "verifyCommands" in patch ? argvList(patch.verifyCommands, "verifyCommands") : cur.verifyCommands;
    const provisionCommand = "provisionCommand" in patch ? argv(patch.provisionCommand, "provisionCommand") : cur.provisionCommand;
    const { testCommand: _t, verifyCommands: _v, provisionCommand: _p, ...base } = cur;
    const next: ProjectConfig = {
      ...base,
      ...(testCommand !== undefined ? { testCommand } : {}),
      ...(verifyCommands !== undefined ? { verifyCommands } : {}),
      ...(provisionCommand !== undefined ? { provisionCommand } : {}),
    };
    this.projects = this.projects.map((p, i) => (i === idx ? next : p));
    return next;
  }

  /** Add a project at runtime. Rejects a duplicate id so two inputs can't alias one clone. */
  add(config: ProjectConfig): void {
    if (this.projects.some((p) => p.id === config.id)) {
      throw new OrchestratorError(`A project with id "${config.id}" already exists`, 409);
    }
    this.projects = [...this.projects, config];
  }

  /** Remove a project at runtime. May empty the registry — Bureau then runs with zero
   *  projects and the panel shows its onboarding again (default()/resolve() 409 meanwhile). */
  remove(id: string): void {
    const next = this.projects.filter((p) => p.id !== id);
    if (next.length === this.projects.length) throw new OrchestratorError(`Unknown project: ${id}`, 404);
    this.projects = next;
  }
}

// ── path safety (derive on-disk locations only from a safe slug id) ───────────

/** Derive a project's clone + worktrees dirs under reposRoot, asserting they can't
 *  escape it (belt-and-suspenders on top of slug() already stripping "/", ".", ".."). */
function derivePaths(reposRoot: string, id: string): { canonicalPath: string; worktreesDir: string } {
  const canonicalPath = join(reposRoot, id, "repo");
  const worktreesDir = join(reposRoot, id, "worktrees");
  if (!resolve(canonicalPath).startsWith(resolve(reposRoot) + sep)) {
    throw new OrchestratorError(`Refusing unsafe project path for id "${id}"`, 400);
  }
  return { canonicalPath, worktreesDir };
}

/** Build a validated config for a CEO-ADDED repo: the URL is allowlisted (https/github),
 *  owner+name are DERIVED from it (single-sourced identity), and the on-disk paths are
 *  derived from the slug id. Throws VcsError (bad URL) or OrchestratorError. */
export function buildProjectConfig(
  reposRoot: string,
  input: {
    url: string;
    baseBranch?: string | undefined;
    testCommand?: readonly string[] | undefined;
    verifyCommands?: readonly (readonly string[])[] | undefined;
    provisionCommand?: readonly string[] | undefined;
  }
): ProjectConfig {
  const { owner, name } = parseGithubRepo(input.url);
  const id = slug(`${owner}-${name}`);
  const baseBranch = input.baseBranch && input.baseBranch.trim() !== "" ? input.baseBranch.trim() : "main";
  const { canonicalPath, worktreesDir } = derivePaths(reposRoot, id);
  return {
    id,
    owner,
    name,
    url: input.url.trim(),
    baseBranch,
    canonicalPath,
    worktreesDir,
    ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
    ...(input.verifyCommands !== undefined ? { verifyCommands: input.verifyCommands } : {}),
    ...(input.provisionCommand !== undefined ? { provisionCommand: input.provisionCommand } : {}),
  };
}

/** Rebuild a config from a persisted row at boot — paths are re-derived from reposRoot
 *  (never stored), the durable facts come from the row (already validated when added). */
export function projectConfigFromRow(
  reposRoot: string,
  row: {
    id: string;
    owner: string;
    name: string;
    url: string;
    baseBranch: string;
    testCommand: string[] | null;
    verifyCommands?: string[][] | null;
    provisionCommand?: string[] | null;
  }
): ProjectConfig {
  const { canonicalPath, worktreesDir } = derivePaths(reposRoot, row.id);
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    url: row.url,
    baseBranch: row.baseBranch,
    canonicalPath,
    worktreesDir,
    ...(row.testCommand && row.testCommand.length > 0 ? { testCommand: row.testCommand } : {}),
    ...(row.verifyCommands && row.verifyCommands.length > 0 ? { verifyCommands: row.verifyCommands } : {}),
    ...(row.provisionCommand && row.provisionCommand.length > 0 ? { provisionCommand: row.provisionCommand } : {}),
  };
}

/** Flatten a config to its persisted-row shape (minus createdAt) — the SINGLE source for which
 *  durable command columns get written, so the add / patch / env-seed paths never drift. */
export function projectRowFromConfig(c: ProjectConfig): Omit<ProjectRow, "createdAt"> {
  return {
    id: c.id,
    owner: c.owner,
    name: c.name,
    url: c.url,
    baseBranch: c.baseBranch,
    testCommand: c.testCommand ? [...c.testCommand] : null,
    verifyCommands: c.verifyCommands ? c.verifyCommands.map((cmd) => [...cmd]) : null,
    provisionCommand: c.provisionCommand ? [...c.provisionCommand] : null,
  };
}

// ── env → projects ──────────────────────────────────────────────────────────

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
}

function requireStr(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`BUREAU_PROJECTS: ${field} must be a non-empty string`);
  }
  return value;
}

/** Reject an argv whose program (argv[0]) looks like a flag — the argument-injection defense
 *  (echoing assertSafeRef's precedent). Shared by the env-boot parser and the runtime PATCH path
 *  so EVERY entry point that can reach the shell-free runner is guarded identically. */
function assertSafeArgv(argv: readonly string[], field: string): void {
  if (argv.length > 0 && argv[0]!.startsWith("-")) {
    throw new OrchestratorError(`${field} ("${argv[0]}") must be a program, not a flag`, 400);
  }
}

/** Parse a CEO-configured test command — a JSON array of non-empty strings (already
 *  tokenized; the runtime never splits a string). Rejects an argv[0] that looks like a flag.
 *  Returns undefined when absent so the field can be spread-omitted (exactOptionalPropertyTypes). */
export function parseTestCommand(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty JSON array of strings (e.g. ["npm","test"])`);
  }
  const argv = value.map((v, i) => {
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${field}[${i}] must be a non-empty string`);
    return v;
  });
  assertSafeArgv(argv, field);
  return argv;
}

/** Parse a CEO-configured verify list — a JSON array of argv arrays (each command validated by
 *  {@link parseTestCommand}). Returns undefined when absent so the field can be spread-omitted. */
export function parseVerifyCommands(value: unknown, field: string): readonly (readonly string[])[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty JSON array of argv arrays (e.g. [["pnpm","build"],["pnpm","test"]])`);
  }
  return value.map((cmd, i) => parseTestCommand(cmd, `${field}[${i}]`)!);
}

/** Build project configs from BUREAU_PROJECTS (JSON array), deriving on-disk paths
 *  under reposRoot. Validates the operator-supplied shape and fails fast. */
export function projectsFromJson(json: string, reposRoot: string): ProjectConfig[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BUREAU_PROJECTS must be a non-empty JSON array");
  }
  return parsed.map((raw, i): ProjectConfig => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const owner = requireStr(r.owner, `projects[${i}].owner`);
    const name = requireStr(r.name, `projects[${i}].name`);
    const url = requireStr(r.url, `projects[${i}].url`);
    const baseBranch = typeof r.baseBranch === "string" && r.baseBranch.trim() !== "" ? r.baseBranch : "main";
    // The id keys the on-disk paths, so it MUST be a safe slug — including any
    // explicit id (slug strips `/`, `.`, `..`, so it can't escape reposRoot).
    // Derive from owner+name (not name alone) so two repos that share a name under
    // different owners don't collide.
    const id = typeof r.id === "string" && r.id.trim() !== "" ? slug(r.id) : slug(`${owner}-${name}`);
    const testCommand = parseTestCommand(r.testCommand, `projects[${i}].testCommand`);
    const verifyCommands = parseVerifyCommands(r.verifyCommands, `projects[${i}].verifyCommands`);
    const provisionCommand = parseTestCommand(r.provisionCommand, `projects[${i}].provisionCommand`);
    const { canonicalPath, worktreesDir } = derivePaths(reposRoot, id);
    return {
      id,
      owner,
      name,
      url,
      baseBranch,
      canonicalPath,
      worktreesDir,
      ...(testCommand !== undefined ? { testCommand } : {}),
      ...(verifyCommands !== undefined ? { verifyCommands } : {}),
      ...(provisionCommand !== undefined ? { provisionCommand } : {}),
    };
  });
}
