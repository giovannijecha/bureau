"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Cpu,
  FolderGit2,
  Wifi,
  WifiOff,
  Server,
  CheckCircle2,
  XCircle,
  GitBranch,
  SlidersHorizontal,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Info,
  Github,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import type { EngineInfo, Project, GithubAccount } from "@bureau/contracts";
import { getConfig, listProjects, ENGINE_URL, getGithubAccount } from "../../lib/api";
import { useTheme } from "../../lib/useTheme";
import { useSidebar } from "../../lib/sidebar";
import { cn } from "../../lib/utils";

export default function SettingsPage() {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [account, setAccount] = useState<GithubAccount | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const i = await getConfig();
        if (alive) {
          setInfo(i);
          setOnline(true);
        }
      } catch {
        if (alive) setOnline(false);
      }
      try {
        const p = await listProjects();
        if (alive) setProjects(p);
      } catch {
        /* offline */
      }
      try {
        const a = await getGithubAccount();
        if (alive) setAccount(a);
      } catch {
        /* gh unavailable */
      }
    }
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="grid max-w-3xl gap-4">
        <PreferencesCard />

        <Card title="Engine" icon={Server}>
          <Row label="URL">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{ENGINE_URL}</code>
          </Row>
          <Row label="Status">
            {online === null ? (
              <span className="text-sm text-muted-foreground">checking…</span>
            ) : online ? (
              <Badge ok>
                <Wifi className="h-3.5 w-3.5" /> Connected
              </Badge>
            ) : (
              <Badge>
                <WifiOff className="h-3.5 w-3.5" /> Offline
              </Badge>
            )}
          </Row>
          {info && <Row label="In-flight tasks">{info.inflightTasks}</Row>}
        </Card>

        <Card title="GitHub" icon={Github}>
          {account === null ? (
            <span className="text-sm text-muted-foreground">checking…</span>
          ) : account.connected ? (
            <>
              <Row label="Account">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                  <Github className="h-3.5 w-3.5" /> {account.login}
                </span>
              </Row>
              {account.name && (
                <Row label="Name">
                  <span className="text-sm">{account.name}</span>
                </Row>
              )}
              <Row label="Status">
                <Badge ok>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                </Badge>
              </Row>
            </>
          ) : (
            <div className="space-y-2">
              <Badge>
                <XCircle className="h-3.5 w-3.5" /> Not connected
              </Badge>
              <p className="text-xs text-muted-foreground">
                Run <code className="font-mono">gh auth login</code> in a terminal to connect your GitHub account — Bureau reuses the gh CLI&apos;s
                authentication (no token is stored).
              </p>
            </div>
          )}
        </Card>

        <Card title="Model provider" icon={Cpu}>
          {info ? (
            <>
              <Row label="Provider">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{info.provider.name}</code>
              </Row>
              <Row label="Available">
                {info.provider.available ? (
                  <Badge ok>
                    <CheckCircle2 className="h-3.5 w-3.5" /> yes
                  </Badge>
                ) : (
                  <Badge>
                    <XCircle className="h-3.5 w-3.5" /> no
                  </Badge>
                )}
              </Row>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Engine offline.</p>
          )}
        </Card>

        <Card title="Projects" icon={FolderGit2}>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None configured — set <code className="font-mono text-xs">BUREAU_PROJECTS</code> on the engine.
            </p>
          ) : (
            <ul className="space-y-2">
              {projects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium">
                    {p.owner}/{p.name}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3" />
                    {p.baseBranch}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="About" icon={Info}>
          <Row label="Version">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">v0.1.0</code>
          </Row>
          <Row label="Edition">
            <span className="text-sm">Local-first</span>
          </Row>
          <Row label="Source">
            <a
              href="https://github.com/giovannijecha/bureau"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary transition-colors hover:underline"
            >
              <Github className="h-3.5 w-3.5" /> giovannijecha/bureau
            </a>
          </Row>
        </Card>

        <p className="text-xs text-muted-foreground">
          Engine configuration (repos, provider, paths) is set via the environment — see{" "}
          <code className="font-mono">apps/engine/.env.example</code>.
        </p>
      </div>
    </div>
  );
}

function PreferencesCard() {
  const { dark, setDark } = useTheme();
  const { collapsed, setCollapsed } = useSidebar();
  return (
    <Card title="Preferences" icon={SlidersHorizontal}>
      <Row label="Theme">
        <Segmented value={dark} onChange={setDark} falseOpt={{ label: "Light", icon: Sun }} trueOpt={{ label: "Dark", icon: Moon }} />
      </Row>
      <Row label="Sidebar">
        <Segmented
          value={collapsed}
          onChange={setCollapsed}
          falseOpt={{ label: "Expanded", icon: PanelLeftOpen }}
          trueOpt={{ label: "Collapsed", icon: PanelLeftClose }}
        />
      </Row>
      <p className="text-xs text-muted-foreground">Saved on this device · the sidebar setting applies to the desktop rail.</p>
    </Card>
  );
}

/** A two-state segmented control (used for the boolean preferences). */
function Segmented({
  value,
  onChange,
  falseOpt,
  trueOpt,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  falseOpt: { label: string; icon: LucideIcon };
  trueOpt: { label: string; icon: LucideIcon };
}) {
  const opts: { v: boolean; label: string; icon: LucideIcon }[] = [
    { v: false, ...falseOpt },
    { v: true, ...trueOpt },
  ];
  return (
    <div className="inline-flex rounded-lg border bg-background p-0.5">
      {opts.map((o) => {
        const Icon = o.icon;
        const active = value === o.v;
        return (
          <button
            key={o.label}
            onClick={() => onChange(o.v)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Card({ title, icon: Icon, children }: { title: string; icon: ComponentType<LucideProps>; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-2.5 px-4 py-3.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function Badge({ ok = false, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        ok ? "border-green-500/40 text-green-500" : "border-red-500/40 text-red-500"
      )}
    >
      {children}
    </span>
  );
}
