"use client";

// A specific project's workspace (deep-linkable). Switching projects is done from the
// global header switcher; the shared component carries all the logic.

import { useParams } from "next/navigation";
import { ProjectWorkspace } from "../../../components/ProjectWorkspace";

export default function ProjectDashboard() {
  const params = useParams();
  return <ProjectWorkspace projectId={String(params.projectId ?? "")} />;
}
