import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { ProjectRegistry, projectsFromJson, slug, toProjectDto, type ProjectConfig } from "../src/projects.js";
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

  it("rejects a malformed project shape", () => {
    expect(() => projectsFromJson(JSON.stringify([{ owner: "a" }]), "/r")).toThrow();
    expect(() => projectsFromJson(JSON.stringify([]), "/r")).toThrow();
  });
});

describe("ProjectRegistry", () => {
  it("requires at least one project and rejects duplicate ids", () => {
    expect(() => new ProjectRegistry([])).toThrow();
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
});
