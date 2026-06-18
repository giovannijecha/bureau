"use client";

// Backwards-compatible entry point: the projects state now lives in a shared context
// (see projects-context.tsx) so a switch re-scopes the whole app live. Existing imports
// of `useProjects` / `UseProjects` keep working unchanged.

export { useProjects, ProjectsProvider } from "./projects-context";
export type { ProjectsState as UseProjects } from "./projects-context";
