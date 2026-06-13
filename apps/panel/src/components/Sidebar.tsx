"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Sparkles,
  ListTodo,
  GitBranch,
  Bot,
  Settings,
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
  { title: "Overview", href: "/overview", icon: LayoutDashboard, soon: true },
  { title: "Assistant", href: "/", icon: Sparkles },
  { title: "Tasks", href: "/tasks", icon: ListTodo },
  { title: "Git", href: "/git", icon: GitBranch, soon: true },
  { title: "Agents", href: "/agents", icon: Bot, soon: true },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
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
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-sm font-bold text-background">
          B
        </div>
        <span className="text-[15px] font-semibold tracking-tight">Bureau</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="space-y-1 border-t px-2 py-3">
        <NavLink item={{ title: "Settings", href: "/settings", icon: Settings, soon: true }} active={isActive("/settings")} />
      </div>
    </aside>
  );
}
