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
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useSidebar } from "../lib/sidebar";

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

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={() => onNavigate?.()}
      title={collapsed ? item.title : undefined}
      aria-label={collapsed ? item.title : undefined}
      className={cn(
        "flex items-center rounded-lg text-[15px] font-medium transition-colors",
        collapsed ? "justify-center px-0 py-2.5" : "gap-3.5 px-3 py-2.5",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="h-[22px] w-[22px] shrink-0" />
      {!collapsed && <span className="truncate">{item.title}</span>}
      {!collapsed && item.soon && (
        <span className="ml-auto rounded-full border border-border px-1.5 py-px text-[10px] font-normal text-muted-foreground">
          soon
        </span>
      )}
    </Link>
  );
}

/** The shared inner content (logo + nav), used by both the desktop rail and the
 *  mobile drawer. `collapsed` only ever applies to the desktop rail. */
function SidebarBody({
  collapsed,
  onNavigate,
  onToggle,
}: {
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
  onToggle?: (() => void) | undefined;
}) {
  const pathname = usePathname() ?? "/";
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <>
      <div className={cn("flex h-16 shrink-0 items-center border-b", collapsed ? "justify-center px-2" : "justify-between gap-2 px-4")}>
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-base font-bold text-background">
              B
            </div>
            <span className="text-lg font-semibold tracking-tight">Bureau</span>
          </div>
        )}
        {onToggle && (
          <button
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ToggleIcon className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>

      <nav className={cn("flex-1 space-y-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-2.5")}>
        {NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="space-y-1 border-t px-2 py-3">
        <NavLink
          item={{ title: "Settings", href: "/settings", icon: Settings }}
          active={isActive("/settings")}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>
    </>
  );
}

export function Sidebar() {
  const { collapsed, drawerOpen, closeDrawer, toggleCollapsed } = useSidebar();

  return (
    <>
      {/* Desktop: a collapsible rail (icon-only when collapsed). Hidden on mobile. */}
      <aside
        className={cn(
          "hidden h-screen shrink-0 flex-col border-r bg-background transition-[width] duration-300 ease-out md:flex",
          collapsed ? "w-[72px]" : "w-64"
        )}
      >
        <SidebarBody collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>

      {/* Mobile: an off-canvas drawer + backdrop, toggled by the Header hamburger. */}
      <div className={cn("fixed inset-0 z-50 md:hidden", drawerOpen ? "" : "pointer-events-none")} aria-hidden={!drawerOpen}>
        <div
          onClick={closeDrawer}
          className={cn("absolute inset-0 bg-black/60 transition-opacity duration-300", drawerOpen ? "opacity-100" : "opacity-0")}
        />
        <aside
          className={cn(
            "absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-background shadow-xl transition-transform duration-300 ease-out",
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <SidebarBody collapsed={false} onNavigate={closeDrawer} />
        </aside>
      </div>
    </>
  );
}
