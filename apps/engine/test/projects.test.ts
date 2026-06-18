import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { ProjectRegistry, projectsFromJson, buildProjectConfig, projectConfigFromRow, slug, toProjectDto, type ProjectConfig } from "../src/projects.js";
import { OrchestratorError } from "../src/errors.js";

const P = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  id: "a",
  owner: "o",
  name: "a",
  url: "u",
  baseBranch: "main",
  canonicalPath: "/c",
  worktreesDir: "/w",
  ...over,
});

describe("slug", () => {
  it("slugifies names and never returns empty", () => {
    expect(slug("Bureau Playground")).toBe("bureau-playground");
    expect(slug("My.Repo_v2")).toBe("my-repo-v2");
    expect(slug("___")).toBe("project");
  });
});

describe("projectsFromJson", () => {
  it("derives id from owner+name and on-disk paths under the repos root", () => {
    const cfgs = projectsFromJson(JSON.stringify([{ owner: "acme", name: "Widget", url: "https://x/widget.git" }]), "/repos");
    expect(cfgs).toHaveLength(1);
    const c = cfgs[0]!;
    expect(c.id).toBe("acme-widget"); // owner+name, so same-name repos under different owners don't collide
    expect(c.baseBranch).toBe("main");
    expect(c.canonicalPath).toBe(join("/repos", "acme-widget", "repo"));
    expect(c.worktreesDir).toBe(join("/repos", "acme-widget", "worktrees"));
  });

  it("keeps two same-name repos under different owners distinct", () => {
    const cfgs = projectsFromJson(
      JSON.stringify([
        { owner: "acme", name: "api", url: "u1" },
        { owner: "globex", name: "api", url: "u2" },
      ]),
      "/r"
    );
    expect(cfgs.map((c) => c.id)).toEqual(["acme-api", "globex-api"]);
  });

  it("slugs an explicit id so it cannot escape the repos root", () => {
    const cfgs = projectsFromJson(JSON.stringify([{ id: "../../etc/passwd", owner: "a", name: "b", url: "u" }]), "/repos");
    expect(cfgs[0]!.id).toBe("etc-passwd"); // no `..` or `/` survive the slug
    expect(cfgs[0]!.canonicalPath).toBe(join("/repos", "etc-passwd", "repo"));
  });

  it("respects an explicit (safe) id + baseBranch", () => {
    const cfgs = projectsFromJson(JSON.stringify([{ id: "x", owner: "a", name: "b", url: "u", baseBranch: "dev" }]), "/r");
    expect(cfgs[0]!.id).toBe("x");
    expect(cfgs[0]!.baseBranch).toBe("dev");
  });

  it("parses a testCommand argv array, and omits it when absent", () => {
    const withTests = projectsFromJson(JSON.stringify([{ owner: "a", name: "b", url: "u", testCommand: ["npm", "test"] }]), "/r");
    expect(withTests[0]!.testCommand).toEqual(["npm", "test"]);
    const without = projectsFromJson(JSON.stringify([{ owner: "a", name: "b", url: "u" }]), "/r");
    expect("testCommand" in without[0]!).toBe(false); // omitted, not undefined
  });

  it("rejects an unsafe / malformed testCommand", () => {
    const bad = (tc: unknown) => () => projectsFromJson(JSON.stringify([{ owner: "a", name: "b", url: "u", testCommand: tc }]), "/r");
    expect(bad("npm test")).toThrow(/JSON array/); // a bare string is rejected (no string-splitting)
    expect(bad([])).toThrow(/non-empty/);
    expect(bad(["npm", ""])).toThrow(/non-empty string/);
    expect(bad(["--evil", "x"])).toThrow(/must be a program, not a flag/); // argv[0] flag = argument-injection defense
  });

  it("rejects a malformed project shape", () => {
    expect(() => projectsFromJson(JSON.stringify([{ owner: "a" }]), "/r")).toThrow();
    expect(() => projectsFromJson(JSON.stringify([]), "/r")).toThrow();
  });
});

describe("ProjectRegistry", () => {
  it("allows zero projects (fresh install) and rejects duplicate ids", () => {
    const empty = new ProjectRegistry([]);
    expect(empty.list()).toEqual([]);
    expect(() => empty.default()).toThrow(expect.objectContaining({ status: 409 })); // 409, not a crash
    expect(() => empty.resolve(undefined)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => new ProjectRegistry([P(), P()])).toThrow(/Duplicate/);
  });

  it("resolves default / by id / by owner+name", () => {
    const reg = new ProjectRegistry([P({ id: "a", owner: "o1", name: "a" }), P({ id: "b", owner: "o2", name: "b" })]);
    expect(reg.default().id).toBe("a");
    expect(reg.resolve(undefined).id).toBe("a");
    expect(reg.resolve("b").id).toBe("b");
    expect(reg.find("o2", "b").id).toBe("b");
  });

  it("get throws 404 for an unknown id; find throws 409 for an unknown repo", () => {
    const reg = new ProjectRegistry([P()]);
    expect(() => reg.get("nope")).toThrow(OrchestratorError);
    expect(() => reg.get("nope")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => reg.find("x", "y")).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("toProjectDto hides the url and on-disk paths", () => {
    expect(toProjectDto(P({ id: "a", owner: "o", name: "n", baseBranch: "main" }))).toEqual({
      id: "a",
      owner: "o",
      name: "n",
      baseBranch: "main",
    });
  });

  it("add appends a project, rejecting a duplicate id (409)", () => {
    const reg = new ProjectRegistry([P({ id: "a" })]);
    reg.add(P({ id: "b", owner: "o2", name: "b" }));
    expect(reg.list().map((p) => p.id)).toEqual(["a", "b"]);
    expect(() => reg.add(P({ id: "a" }))).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("remove drops a project, 404 on unknown, can empty the registry, and shifts the default", () => {
    const reg = new ProjectRegistry([P({ id: "a" }), P({ id: "b", owner: "o2", name: "b" })]);
    expect(() => reg.remove("nope")).toThrow(expect.objectContaining({ status: 404 }));
    reg.remove("a");
    expect(reg.list().map((p) => p.id)).toEqual(["b"]);
    expect(reg.default().id).toBe("b"); // default shifts to the survivor
    reg.remove("b"); // removing the last is now allowed — back to the fresh-install state
    expect(reg.list()).toEqual([]);
    expect(() => reg.default()).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe("buildProjectConfig — CEO-added repo (validated)", () => {
  it("derives owner/name/id + safe paths from a valid github URL", () => {
    const c = buildProjectConfig("/repos", { url: "https://github.com/Acme/Widget.git" });
    expect({ id: c.id, owner: c.owner, name: c.name, baseBranch: c.baseBranch }).toEqual({
      id: "acme-widget",
      owner: "Acme",
      name: "Widget",
      baseBranch: "main",
    });
    expect(c.canonicalPath).toBe(join("/repos", "acme-widget", "repo"));
  });

  it("honors an explicit baseBranch + testCommand", () => {
    const c = buildProjectConfig("/repos", { url: "https://github.com/a/b", baseBranch: "dev", testCommand: ["pnpm", "test"] });
    expect(c.baseBranch).toBe("dev");
    expect(c.testCommand).toEqual(["pnpm", "test"]);
  });

  it("rejects an unsafe URL (file://, ssh, non-github)", () => {
    expect(() => buildProjectConfig("/repos", { url: "file:///etc/passwd" })).toThrow();
    expect(() => buildProjectConfig("/repos", { url: "git@github.com:a/b.git" })).toThrow();
    expect(() => buildProjectConfig("/repos", { url: "https://evil.com/a/b" })).toThrow();
  });
});

describe("projectConfigFromRow — rebuild at boot", () => {
  it("re-derives on-disk paths from reposRoot + id (paths are never stored)", () => {
    const c = projectConfigFromRow("/repos", { id: "acme-widget", owner: "acme", name: "widget", url: "https://github.com/acme/widget", baseBranch: "main", testCommand: ["npm", "test"] });
    expect(c.canonicalPath).toBe(join("/repos", "acme-widget", "repo"));
    expect(c.worktreesDir).toBe(join("/repos", "acme-widget", "worktrees"));
    expect(c.testCommand).toEqual(["npm", "test"]);
  });

  it("omits testCommand when the row has none", () => {
    const c = projectConfigFromRow("/r", { id: "a", owner: "o", name: "n", url: "u", baseBranch: "main", testCommand: null });
    expect("testCommand" in c).toBe(false);
  });
});
