"use client";

import { usePathname } from "next/navigation";
import {
  Wifi,
  WifiOff,
  Sparkles,
  LayoutDashboard,
  FolderGit2,
  ListTodo,
  GitBranch,
  Bot,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useEngineOnline } from "../lib/useEngineOnline";
import { ThemeToggle } from "./ThemeToggle";
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
  { match: (p) => p.startsWith("/overview"), title: "Overview", subtitle: "Your team at a glance", icon: LayoutDashboard },
  { match: (p) => p.startsWith("/projects"), title: "Projects", subtitle: "The repositories Bureau works on", icon: FolderGit2 },
  { match: (p) => p === "/tasks", title: "Tasks", subtitle: "Every task Iris has run", icon: ListTodo },
  { match: (p) => p.startsWith("/tasks/"), title: "Task", subtitle: "Pipeline, diff, and review", icon: ListTodo },
  { match: (p) => p.startsWith("/git"), title: "Git", subtitle: "Branches, worktrees, and PRs", icon: GitBranch },
  { match: (p) => p.startsWith("/agents"), title: "Agents", subtitle: "Your capability workers", icon: Bot },
  { match: (p) => p.startsWith("/settings"), title: "Settings", subtitle: "Configuration and connection", icon: Settings },
];

export function Header() {
  const pathname = usePathname() ?? "/";
  const section = SECTIONS.find((s) => s.match(pathname)) ?? SECTIONS[0]!;
  const Icon = section.icon;
  const online = useEngineOnline();

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-background px-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-none tracking-tight">{section.title}</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">{section.subtitle}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
            online === false ? "border-red-500/40 text-red-500" : "border-green-500/40 text-green-500"
          )}
          title={online === false ? "Engine offline" : "Engine connected"}
        >
          {online === false ? <WifiOff className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{online === false ? "Offline" : "Connected"}</span>
        </span>
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
