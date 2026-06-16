import type { ReactNode } from "react";
import { Play } from "lucide-react";

/** Code-fence languages that denote a runnable shell command (gets a "Run" button).
 *  An UNTAGGED fence ("") is excluded — Iris is told to tag runnable commands ```bash,
 *  so bare fences are quoted snippets, not commands to offer running. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "powershell", "ps", "ps1", "pwsh"]);

/**
 * A tiny, dependency-free markdown renderer — enough for Iris's chat replies and
 * the memory vault: headings, bullet + numbered lists, fenced + inline code,
 * bold, links, and paragraph spacing. Inherits the surrounding font size so it
 * reads well in a chat bubble or a note page alike.
 *
 * When `onRun` is given, a shell code block gets a "Run" button — the mechanism by which
 * Iris proposes a command the CEO runs. Behaviour depends on the consumer's `onRun`: on
 * the Assistant page it stages an inline RunCommand (executes in the chat after a confirm);
 * in the Terminal's IrisDock it pre-fills the terminal for the CEO to review and run.
 */
export function Markdown({ source, onRun }: { source: string; onRun?: ((code: string) => void) | undefined }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  let ordered: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="my-1.5 list-disc space-y-1 pl-5">
        {bullets.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>
    );
    bullets = [];
  };
  const flushOrdered = () => {
    if (ordered.length === 0) return;
    out.push(
      <ol key={`ol-${out.length}`} className="my-1.5 list-decimal space-y-1 pl-5">
        {ordered.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ol>
    );
    ordered = [];
  };
  const flush = () => {
    flushBullets();
    flushOrdered();
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trimEnd();

    // Fenced code block: ```lang … ``` — collect verbatim until the closing fence
    // (or end of input) and render as one block. This is what was previously
    // leaking raw backticks into the chat.
    const fence = /^\s*```(\w*)\s*$/.exec(l);
    if (fence) {
      flush();
      const lang = (fence[1] ?? "").toLowerCase();
      const code: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^\s*```\s*$/.test(lines[j]!)) break; // closing fence
        code.push(lines[j]!);
      }
      const codeStr = code.join("\n");
      const runnable = onRun !== undefined && SHELL_LANGS.has(lang) && codeStr.trim() !== "";
      out.push(
        <div key={i} className="group/code relative my-2">
          <pre className="overflow-x-auto rounded-lg border bg-muted/60 px-3 py-2.5 font-mono text-[0.85em] leading-relaxed">
            <code>{codeStr}</code>
          </pre>
          {runnable && (
            <button
              onClick={() => onRun!(codeStr)}
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus:opacity-100 group-hover/code:opacity-100"
              title="Run this command and show the output here"
            >
              <Play className="h-3 w-3" /> Run
            </button>
          )}
        </div>
      );
      i = j; // skip past the closing fence (or to EOF)
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(l);
    const num = /^\s*\d+\.\s+(.*)$/.exec(l);
    if (bullet) {
      flushOrdered();
      bullets.push(bullet[1]!);
      continue;
    }
    if (num) {
      flushBullets();
      ordered.push(num[1]!);
      continue;
    }
    flush();
    if (l.startsWith("### ")) out.push(<h3 key={i} className="mb-1 mt-3 font-semibold">{inline(l.slice(4))}</h3>);
    else if (l.startsWith("## ")) out.push(<h2 key={i} className="mb-1.5 mt-4 text-[0.95em] font-semibold uppercase tracking-wide text-muted-foreground">{inline(l.slice(3))}</h2>);
    else if (l.startsWith("# ")) out.push(<h1 key={i} className="mb-2 text-lg font-bold tracking-tight">{inline(l.slice(2))}</h1>);
    else if (l === "---" || l === "***") out.push(<hr key={i} className="my-3 border-border" />);
    else if (l.trim() === "") out.push(<div key={i} className="h-2" />);
    else out.push(<p key={i} className="my-1 leading-relaxed">{inline(l)}</p>);
  }
  flush();
  return <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{out}</div>;
}

/** Inline **bold**, `code`, and [text](url) links. */
function inline(text: string): ReactNode {
  // Split on bold / code / link spans, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{p.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
    if (link) {
      const href = link[2]!;
      // Only http(s)/mailto render as links — a relative or javascript: URL (e.g. a
      // disguised /terminal?run= deep link in an agent-authored reply) is shown as
      // plain text, never a clickable navigation.
      if (/^(https?:|mailto:)/i.test(href)) {
        return (
          <a key={i} href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80">
            {link[1]}
          </a>
        );
      }
      return <span key={i}>{link[1]}</span>;
    }
    return <span key={i}>{p}</span>;
  });
}
