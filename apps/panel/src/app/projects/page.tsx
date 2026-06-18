"use client";

// The Projects section is workspace-first: it opens the ACTIVE project's workspace
// directly (Image: pick a repo from the header switcher → land in its workspace).
// The all-projects overview lives in the header switcher's dropdown; cross-project
// activity lives in the Hub.

import { useProjects } from "../../lib/useProjects";
import { ProjectWorkspace } from "../../components/ProjectWorkspace";

export default function ProjectsPage() {
  const { activeId } = useProjects();
  return <ProjectWorkspace projectId={activeId} />;
}
