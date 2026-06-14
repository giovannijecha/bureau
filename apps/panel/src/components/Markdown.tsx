import type { ReactNode } from "react";

/**
 * A tiny, dependency-free markdown renderer — enough for Iris's chat replies and
 * the memory vault: headings, bullet + numbered lists, bold, inline code, links,
 * and paragraph spacing. Inherits the surrounding font size so it reads well in a
 * chat bubble or a note page alike.
 */
export function Markdown({ source }: { source: string }) {
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
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80">
          {link[1]}
        </a>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
