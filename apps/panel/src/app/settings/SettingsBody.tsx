"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Cpu,
  Coins,
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
  Info,
  ExternalLink,
  KeyRound,
  Copy,
  Check,
  Sparkles,
  Leaf,
  Monitor,
  Palette,
  Plus,
  Trash2,
  Loader2,
  Terminal as TerminalIcon,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import type { EngineInfo, GithubAccount } from "@bureau/contracts";
import { getConfig, ENGINE_URL, getGithubAccount, setModels, setBudget, createProject, removeProject } from "../../lib/api";
import { useAppearance, ACCENTS, SCALES, type ThemeMode, type ScaleKey } from "../../lib/appearance";
import { useProjects } from "../../lib/useProjects";
import { useConfirm } from "../../components/ConfirmDialog";
import { Dropdown } from "../../components/Dropdown";
import { cn } from "../../lib/utils";

// The per-scope model picker (kept in sync with the engine's KNOWN_MODELS).
const MODEL_OPTIONS = [
  { value: "claude-opus-4-8", label: "Opus 4.8 — strongest" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — cheaper" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 — cheapest" },
];
const MODEL_SCOPE_ORDER = ["iris", "plan", "research", "edit", "review", "document"];
const SCOPE_LABELS: Record<string, string> = {
  iris: "Iris (chat)",
  plan: "Planner",
  research: "Researcher",
  edit: "Editor",
  review: "Reviewer",
  document: "Scribe",
};

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "connections", label: "Connections", icon: KeyRound },
  { id: "models", label: "Models", icon: Cpu },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "system", label: "System", icon: Server },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsBody({ initialSection }: { initialSection?: string | undefined } = {}) {
  const [section, setSection] = useState<SectionId>(
    SECTIONS.some((s) => s.id === initialSection) ? (initialSection as SectionId) : "general"
  );
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [account, setAccount] = useState<GithubAccount | null>(null);

  async function changeModel(scope: string, model: string) {
    setInfo((prev) => (prev ? { ...prev, models: { ...prev.models, [scope]: model } } : prev)); // optimistic
    try {
      const res = await setModels({ [scope]: model });
      setInfo((prev) => (prev ? { ...prev, models: res.models } : prev)); // authoritative — avoids a poll-race revert
    } catch {
      /* the 5s poll re-syncs the authoritative value */
    }
  }

  async function applyPreset(model: string) {
    if (!info) return;
    const map = Object.fromEntries(Object.keys(info.models).map((s) => [s, model]));
    setInfo((prev) => (prev ? { ...prev, models: map } : prev)); // optimistic
    try {
      const res = await setModels(map);
      setInfo((prev) => (prev ? { ...prev, models: res.models } : prev));
    } catch {
      /* poll re-syncs */
    }
  }

  async function changeBudget(usd: number) {
    setInfo((prev) => (prev ? { ...prev, budgetUsd: usd } : prev)); // optimistic
    try {
      const res = await setBudget(usd);
      setInfo((prev) => (prev ? { ...prev, budgetUsd: res.budgetUsd } : prev));
    } catch {
      /* the 5s poll re-syncs the authoritative value */
    }
  }

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
    <div className="flex flex-col gap-5 lg:flex-row">
        {/* Section nav — a vertical rail on desktop, a horizontal scroller on mobile. */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto pb-1 lg:w-48 lg:flex-col lg:overflow-visible lg:pb-0">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors lg:w-full",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-4">
          {section === "general" && <AppearanceCard />}

          {section === "connections" && (
            <>
              <ModelProviderCard info={info} />
              <GithubCard account={account} />
              <p className="px-1 text-xs text-muted-foreground">
                Bureau stores no credentials — GitHub auth lives in the <code className="font-mono">gh</code> CLI and the model key in the engine&apos;s
                environment. Hosted sign-in (OAuth) and a panel access lock are separate, opt-in features.
              </p>
            </>
          )}

          {section === "models" && (
            <>
              <ModelsCard info={info} onChange={changeModel} onPreset={applyPreset} />
              <BudgetCard info={info} onChange={changeBudget} />
            </>
          )}

          {section === "projects" && <ProjectsCard />}

          {section === "system" && <SystemCard info={info} online={online} />}
        </div>
    </div>
  );
}

function AppearanceCard() {
  const { mode, accent, scale, reduceMotion, setMode, setAccent, setScale, setReduceMotion } = useAppearance();
  const activeAccent = ACCENTS.find((a) => a.key === accent) ?? ACCENTS[0]!;
  return (
    <Card title="Appearance" icon={Palette}>
      {/* Theme — visual preview tiles. */}
      <div>
        <div className="mb-2.5 text-sm font-medium">Theme</div>
        <div className="grid grid-cols-3 gap-2.5">
          <ThemeTile value="light" label="Light" icon={Sun} active={mode === "light"} onClick={() => setMode("light")} />
          <ThemeTile value="dark" label="Dark" icon={Moon} active={mode === "dark"} onClick={() => setMode("dark")} />
          <ThemeTile value="system" label="System" icon={Monitor} active={mode === "system"} onClick={() => setMode("system")} />
        </div>
      </div>

      {/* The rest — roomy, divided rows with a description each. */}
      <div className="divide-y border-t">
        <SettingRow title="Accent" desc={`Highlight color across Bureau — ${activeAccent.label}.`}>
          <div className="flex items-center gap-2">
            {ACCENTS.map((acc) => {
              const active = accent === acc.key;
              return (
                <button
                  key={acc.key}
                  onClick={() => setAccent(acc.key)}
                  title={acc.label}
                  aria-label={acc.label}
                  aria-pressed={active}
                  className={cn(
                    "h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-card transition-all hover:scale-110",
                    active ? "ring-foreground" : "ring-transparent hover:ring-border"
                  )}
                  style={{ background: acc.swatch || "linear-gradient(135deg, var(--foreground) 50%, var(--muted-foreground) 50%)" }}
                />
              );
            })}
          </div>
        </SettingRow>
        <SettingRow title="Scale" desc="Overall size of the interface.">
          <Choice<ScaleKey> value={scale} onChange={setScale} options={SCALES.map((s) => ({ value: s.key, label: s.label }))} />
        </SettingRow>
        <SettingRow title="Motion" desc="Reduce animations and transitions.">
          <Choice<"full" | "reduced">
            value={reduceMotion ? "reduced" : "full"}
            onChange={(v) => setReduceMotion(v === "reduced")}
            options={[
              { value: "full", label: "Full" },
              { value: "reduced", label: "Reduced" },
            ]}
          />
        </SettingRow>
      </div>
      <p className="text-xs text-muted-foreground">Saved on this device. Theme can follow your OS; reduced motion stops animations.</p>
    </Card>
  );
}

// A static mini-mockup of the app in a given palette — the body of a theme preview tile.
function MiniPreview({ bg, side, bar }: { bg: string; side: string; bar: string }) {
  return (
    <div className="flex h-full w-full" style={{ background: bg }}>
      <div className="h-full w-1/3" style={{ background: side }} />
      <div className="flex flex-1 flex-col justify-center gap-1 px-1.5">
        <div className="h-1.5 w-3/4 rounded-full" style={{ background: "var(--primary)" }} />
        <div className="h-1 w-full rounded-full" style={{ background: bar }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: bar }} />
      </div>
    </div>
  );
}

const PV_LIGHT = { bg: "#ffffff", side: "#f1f1f4", bar: "#d4d4d8" };
const PV_DARK = { bg: "#18181b", side: "#27272a", bar: "#3f3f46" };

function ThemeTile({
  value,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  value: ThemeMode;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-1.5 text-left transition-all",
        active ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/30"
      )}
    >
      <div className="h-14 w-full overflow-hidden rounded-md border">
        {value === "light" && <MiniPreview {...PV_LIGHT} />}
        {value === "dark" && <MiniPreview {...PV_DARK} />}
        {value === "system" && (
          <div className="flex h-full w-full">
            <div className="w-1/2 overflow-hidden border-r">
              <MiniPreview {...PV_LIGHT} />
            </div>
            <div className="w-1/2 overflow-hidden">
              <MiniPreview {...PV_DARK} />
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-0.5 pb-0.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">{label}</span>
        {active && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
      </div>
    </button>
  );
}

/** A roomy settings row: title + description on the left, control on the right. */
function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A segmented control over N string options (icons optional). */
function Choice<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: LucideIcon }[];
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-xl bg-muted/40 p-1">
      {options.map((o) => {
        const Icon = o.icon;
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ModelProviderCard({ info }: { info: EngineInfo | null }) {
  return (
    <Card title="Model provider" icon={KeyRound}>
      {info ? (
        <>
          <Row label="Provider">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{info.provider.name}</code>
          </Row>
          <Row label="Authenticated">
            {info.provider.available ? (
              <Badge ok>
                <CheckCircle2 className="h-3.5 w-3.5" /> Ready
              </Badge>
            ) : (
              <Badge>
                <XCircle className="h-3.5 w-3.5" /> Not configured
              </Badge>
            )}
          </Row>
          {!info.provider.available && (
            <p className="text-xs text-muted-foreground">
              Set <code className="font-mono">ANTHROPIC_API_KEY</code> when launching the engine, or sign in with the local{" "}
              <code className="font-mono">claude</code> CLI — Bureau uses whichever is available and never stores the key.
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Engine offline.</p>
      )}
    </Card>
  );
}

function GithubCard({ account }: { account: GithubAccount | null }) {
  return (
    <Card title="GitHub" icon={ExternalLink}>
      {account === null ? (
        <span className="text-sm text-muted-foreground">checking…</span>
      ) : account.connected ? (
        <>
          <Row label="Account">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <ExternalLink className="h-3.5 w-3.5" /> {account.login}
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
        <div className="space-y-2.5">
          <Badge>
            <XCircle className="h-3.5 w-3.5" /> Not connected
          </Badge>
          <p className="text-xs text-muted-foreground">
            Bureau reuses the <code className="font-mono">gh</code> CLI&apos;s authentication (no token is stored). Run this in a terminal to connect:
          </p>
          <CopyCommand command="gh auth login" />
        </div>
      )}
    </Card>
  );
}

function ModelsCard({ info, onChange, onPreset }: { info: EngineInfo | null; onChange: (s: string, m: string) => void; onPreset: (m: string) => void }) {
  if (!info || !info.models) {
    return (
      <Card title="Models" icon={Cpu}>
        <p className="text-sm text-muted-foreground">Engine offline.</p>
      </Card>
    );
  }
  return (
    <Card title="Models" icon={Cpu}>
      <p className="text-xs text-muted-foreground">
        Which model each worker runs on. Cheaper models cut cost (see Metrics). Applies for this session; set{" "}
        <code className="font-mono">BUREAU_MODEL_*</code> on the engine for a permanent default.
      </p>
      <div className="flex flex-wrap gap-2">
        <PresetButton icon={Sparkles} label="Max quality" hint="all Opus" onClick={() => onPreset("claude-opus-4-8")} />
        <PresetButton icon={Leaf} label="Cost-saver" hint="all Sonnet" onClick={() => onPreset("claude-sonnet-4-6")} />
      </div>
      <div className="space-y-2.5 border-t pt-3">
        {MODEL_SCOPE_ORDER.filter((s) => info.models[s] !== undefined).map((s) => (
          <Row key={s} label={SCOPE_LABELS[s] ?? s}>
            <Dropdown value={info.models[s]!} options={MODEL_OPTIONS} onChange={(m) => onChange(s, m)} buttonClassName="h-8" />
          </Row>
        ))}
      </div>
    </Card>
  );
}

function ProjectsCard() {
  const { projects, refresh } = useProjects();
  const confirm = useConfirm();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createProject({ url: trimmed });
      setUrl("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: { id: string; owner: string; name: string }) {
    const ok = await confirm({
      title: "Remove project?",
      description: `“${p.owner}/${p.name}” will be removed and its local clone deleted. Tasks already merged are unaffected; re-adding re-clones it. This can't be undone.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    setError(null);
    try {
      await removeProject(p.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card title="Projects" icon={FolderGit2}>
      {/* Add a repo by URL — the engine validates, clones, and registers it. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="https://github.com/owner/repo"
          className="h-9 min-w-[200px] flex-1 rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-primary/60"
        />
        <button
          onClick={() => void add()}
          disabled={busy || url.trim() === ""}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add
        </button>
      </div>
      {error && <p className="text-xs text-destructive">⚠ {error}</p>}

      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet — add one above.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {projects.map((p) => (
            <li key={p.id} className="group flex items-center gap-2.5 px-3 py-2.5">
              <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {p.owner}/{p.name}
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="h-3 w-3" /> {p.baseBranch}
                </div>
              </div>
              <button
                onClick={() => void remove(p)}
                title="Remove project"
                aria-label={`Remove ${p.owner}/${p.name}`}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Repos are cloned under the engine&apos;s repos root. Only <code className="font-mono">https://github.com/…</code> URLs — no credentials are stored.
      </p>
    </Card>
  );
}

function BudgetCard({ info, onChange }: { info: EngineInfo | null; onChange: (usd: number) => void }) {
  const [val, setVal] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (info) setVal(info.budgetUsd > 0 ? String(info.budgetUsd) : "");
  }, [info?.budgetUsd]);
  if (!info) return null;
  const parsed = val.trim() === "" ? 0 : Number(val);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000;
  const dirty = valid && parsed !== info.budgetUsd;
  function save() {
    if (!dirty) return;
    onChange(parsed);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }
  return (
    <Card title="Budget" icon={Coins}>
      <p className="text-sm text-muted-foreground">
        A per-task spend cap. A running task stops before its next step once it crosses this — protection against a runaway
        pipeline. The proposal card warns when an estimate would exceed it. Applies for this session; set{" "}
        <code className="font-mono text-xs">BUREAU_TASK_BUDGET_USD</code> on the engine for a permanent default.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            inputMode="decimal"
            placeholder="0.00"
            aria-label="Per-task budget cap in USD"
            className="h-9 w-32 rounded-md border bg-background pl-6 pr-3 text-sm outline-none transition-colors focus:border-primary/60"
          />
        </div>
        <span className="text-xs text-muted-foreground">per task · 0 = no cap</span>
        <button
          onClick={save}
          disabled={!dirty}
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saved ? <Check className="h-4 w-4" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      {!valid && <p className="text-xs text-destructive">Enter an amount between $0 and $1000.</p>}
    </Card>
  );
}

function SystemCard({ info, online }: { info: EngineInfo | null; online: boolean | null }) {
  return (
    <>
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
            <ExternalLink className="h-3.5 w-3.5" /> giovannijecha/bureau
          </a>
        </Row>
      </Card>
    </>
  );
}

/** A read-only command with a one-click copy button. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background p-1 pl-3">
      <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function PresetButton({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <Icon className="h-4 w-4 shrink-0 text-primary" />
      <span className="leading-tight">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </button>
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
