"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sparkles,
  ListTodo,
  FolderGit2,
  GitBranch,
  Bot,
  Settings,
  LayoutDashboard,
  BrainCircuit,
  BarChart3,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";

interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { title: "Hub", href: "/hub", icon: LayoutDashboard },
  { title: "Assistant", href: "/", icon: Sparkles },
  { title: "Projects", href: "/projects", icon: FolderGit2 },
  { title: "Tasks", href: "/tasks", icon: ListTodo },
  { title: "Git", href: "/git", icon: GitBranch },
  { title: "Terminal", href: "/terminal", icon: Terminal },
  { title: "Agents", href: "/agents", icon: Bot },
  { title: "Memory", href: "/memory", icon: BrainCircuit },
  { title: "Metrics", href: "/metrics", icon: BarChart3 },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3.5 rounded-lg px-3 py-2.5 text-[15px] font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="h-[22px] w-[22px] shrink-0" />
      <span>{item.title}</span>
      {item.soon && (
        <span className="ml-auto rounded-full border border-border px-1.5 py-px text-[10px] font-normal text-muted-foreground">
          soon
        </span>
      )}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex h-16 items-center gap-2.5 border-b px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-base font-bold text-background">
          B
        </div>
        <span className="text-lg font-semibold tracking-tight">Bureau</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-4">
        {NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="space-y-1 border-t px-2 py-3">
        <NavLink item={{ title: "Settings", href: "/settings", icon: Settings }} active={isActive("/settings")} />
      </div>
    </aside>
  );
}
