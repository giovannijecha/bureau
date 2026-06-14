// Projects — the GitHub repositories Bureau works on. Each project has its own
// canonical clone and worktrees directory; tasks run against the project the CEO
// selected in the Assistant. The registry is the single source of truth for which
// repos exist and where they live on disk.

import { join } from "node:path";
import type { Project } from "@bureau/contracts";
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
}

/** Public, panel-facing view of a project (no urls or on-disk paths). */
export function toProjectDto(p: ProjectConfig): Project {
  return { id: p.id, owner: p.owner, name: p.name, baseBranch: p.baseBranch };
}

export class ProjectRegistry {
  private readonly projects: readonly ProjectConfig[];

  constructor(projects: readonly ProjectConfig[]) {
    if (projects.length === 0) throw new Error("ProjectRegistry needs at least one project");
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

  /** The default project (the first one) — used when no project is specified. */
  default(): ProjectConfig {
    return this.projects[0]!;
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

/** Parse a CEO-configured test command — a JSON array of non-empty strings (already
 *  tokenized; the runtime never splits a string). Rejects an argv[0] that looks like
 *  a flag (argument-injection defense, echoing assertSafeRef's precedent). Returns
 *  undefined when absent so the field can be spread-omitted (exactOptionalPropertyTypes). */
export function parseTestCommand(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty JSON array of strings (e.g. ["npm","test"])`);
  }
  const argv = value.map((v, i) => {
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${field}[${i}] must be a non-empty string`);
    return v;
  });
  if (argv[0]!.startsWith("-")) throw new Error(`${field}[0] ("${argv[0]}") must be a program, not a flag`);
  return argv;
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
    return {
      id,
      owner,
      name,
      url,
      baseBranch,
      canonicalPath: join(reposRoot, id, "repo"),
      worktreesDir: join(reposRoot, id, "worktrees"),
      ...(testCommand !== undefined ? { testCommand } : {}),
    };
  });
}
