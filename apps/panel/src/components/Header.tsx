"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  WifiOff,
  Sparkles,
  LayoutDashboard,
  FolderGit2,
  ListTodo,
  GitBranch,
  Bot,
  BrainCircuit,
  BarChart3,
  Terminal,
  Menu,
  type LucideIcon,
} from "lucide-react";
import { useEngineOnline } from "../lib/useEngineOnline";
import { useSidebar } from "../lib/sidebar";
import { useProjects } from "../lib/useProjects";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { cn } from "../lib/utils";

// One consistent top bar for every section, driven by the route — so the header
// is identical in height, type scale, and spacing everywhere (no per-page drift).
interface SectionMeta {
  match: (p: string) => boolean;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

const SECTIONS: SectionMeta[] = [
  { match: (p) => p === "/", title: "Assistant", subtitle: "Talk with Iris — she turns it into a task", icon: Sparkles },
  { match: (p) => p.startsWith("/hub"), title: "Hub", subtitle: "Your command center — live work, activity, and what's waiting on you", icon: LayoutDashboard },
  { match: (p) => p.startsWith("/memory"), title: "Memory", subtitle: "The org's durable brain — journals & notes", icon: BrainCircuit },
  { match: (p) => p.startsWith("/metrics"), title: "Metrics", subtitle: "Token usage & estimated cost", icon: BarChart3 },
  { match: (p) => p.startsWith("/projects"), title: "Projects", subtitle: "The repositories Bureau works on", icon: FolderGit2 },
  { match: (p) => p === "/tasks", title: "Tasks", subtitle: "Every task Iris has run", icon: ListTodo },
  { match: (p) => p.startsWith("/tasks/"), title: "Task", subtitle: "Pipeline, diff, and review", icon: ListTodo },
  { match: (p) => p.startsWith("/git"), title: "Git", subtitle: "Branches, worktrees, and PRs", icon: GitBranch },
  { match: (p) => p.startsWith("/terminal"), title: "Terminal", subtitle: "A human-operated shell in your project's clone", icon: Terminal },
  { match: (p) => p.startsWith("/agents"), title: "Agents", subtitle: "Your capability workers", icon: Bot },
];

export function Header() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const section = SECTIONS.find((s) => s.match(pathname)) ?? SECTIONS[0]!;
  const Icon = section.icon;
  const online = useEngineOnline();
  const { openDrawer } = useSidebar();
  const { projects, active, setActiveId } = useProjects();

  // The global repo switcher re-scopes the whole app. On the Projects section it also moves
  // to the picked project's workspace (URL + view follow the pick); on a working page (Git,
  // Terminal, …) it re-scopes IN PLACE so you can switch repo without being yanked off the
  // page you're on.
  function switchProject(id: string) {
    setActiveId(id);
    if (pathname.startsWith("/projects")) router.push(`/projects/${id}`);
  }

  const navBtn =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b bg-background px-3 sm:gap-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {/* Mobile: open the off-canvas nav drawer (sidebar is hidden on phones). */}
        <button onClick={openDrawer} aria-label="Open navigation" className={cn(navBtn, "md:hidden")}>
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-none tracking-tight">{section.title}</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">{section.subtitle}</p>
        </div>
        {/* Global project switcher — what Iris is scoped to, switchable from every page (md+). */}
        {projects.length > 0 && (
          <>
            <div className="mx-1 hidden h-6 w-px shrink-0 bg-border md:block" />
            <div className="hidden min-w-0 max-w-[200px] md:block lg:max-w-[260px]">
              <ProjectSwitcher projects={projects} active={active} onChange={switchProject} />
            </div>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {online === false ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-500"
            title="Engine offline"
          >
            <WifiOff className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Offline</span>
          </span>
        ) : (
          <span
            className={cn("h-2 w-2 rounded-full", online === null ? "bg-muted-foreground/40" : "bg-green-500")}
            title={online === null ? "Connecting…" : "Engine connected"}
            aria-label={online === null ? "Connecting" : "Engine connected"}
          />
        )}
        <NotificationBell />
        <ThemeToggle />
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            CEO
          </div>
          <span className="hidden text-sm font-medium sm:inline">Giovanni</span>
        </div>
      </div>
    </header>
  );
}
