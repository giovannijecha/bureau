"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Cpu, FolderGit2, Wifi, WifiOff, Server, CheckCircle2, XCircle, GitBranch, type LucideProps } from "lucide-react";
import type { EngineInfo, Project } from "@bureau/contracts";
import { getConfig, listProjects, ENGINE_URL } from "../../lib/api";
import { cn } from "../../lib/utils";

export default function SettingsPage() {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);

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
    }
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="grid max-w-3xl gap-4">
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
                <li key={p.id} className="flex items-center gap-2 text-sm">
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

        <p className="text-xs text-muted-foreground">
          Configuration is set via the engine&apos;s environment — see <code className="font-mono">apps/engine/.env.example</code>.
        </p>
      </div>
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
