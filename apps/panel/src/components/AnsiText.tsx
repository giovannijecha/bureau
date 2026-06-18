"use client";

// Renders text containing ANSI SGR colour codes (and strips OSC/cursor/control noise)
// into styled spans. Shared by the embedded Terminal and the inline command-run in the
// Iris chat, so both show identical, coloured output. The engine forces colour
// (FORCE_COLOR / git color.ui=always) precisely so the panel can render it here.

import { memo, useMemo, type ReactNode } from "react";

type AnsiStyle = { fg?: string; bold?: boolean; dim?: boolean; underline?: boolean };

// Catppuccin Mocha ANSI palette — soft pastels that read well on any dark surface
// (the Terminal's #1e1e2e base and the Iris chat's card alike).
const ANSI_FG: Record<number, string> = {
  30: "text-[#6c7086]", 31: "text-[#f38ba8]", 32: "text-[#a6e3a1]", 33: "text-[#f9e2af]",
  34: "text-[#89b4fa]", 35: "text-[#f5c2e7]", 36: "text-[#94e2d5]", 37: "text-[#bac2de]",
  90: "text-[#7f849c]", 91: "text-[#f38ba8]", 92: "text-[#a6e3a1]", 93: "text-[#f9e2af]",
  94: "text-[#89b4fa]", 95: "text-[#f5c2e7]", 96: "text-[#89dceb]", 97: "text-[#cdd6f4]",
};

function applySgr(style: AnsiStyle, codeStr: string): AnsiStyle {
  const codes = codeStr === "" ? [0] : codeStr.split(";").map((x) => parseInt(x, 10) || 0);
  let s: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) {
      s.bold = false;
      s.dim = false;
    } else if (c === 24) s.underline = false;
    else if (c === 39) delete s.fg;
    else if (ANSI_FG[c]) s.fg = ANSI_FG[c];
    else if (c === 38 && codes[i + 1] === 5) {
      const mapped = ANSI_FG[codes[i + 2] ?? -1];
      if (mapped) s.fg = mapped;
      else delete s.fg;
      i += 2; // 256-colour → nearest basic (best-effort)
    }
  }
  return s;
}

function styleClass(s: AnsiStyle): string {
  return [s.fg ?? "", s.bold ? "font-semibold" : "", s.dim ? "opacity-70" : "", s.underline ? "underline" : ""].filter(Boolean).join(" ");
}

// ESC is built from a char code so NO literal control byte ever sits in this source.
// The strip/colour regexes are built via `new RegExp` from plain-ASCII strings.
const ESC = String.fromCharCode(27);
const OSC_RE = new RegExp(ESC + "\\][^\\u0007" + ESC + "]*(?:\\u0007|" + ESC + "\\\\)", "g"); // window-title etc.
const CSI_NON_SGR_RE = new RegExp(ESC + "\\[[0-9;?]*[A-HJKSTfhlsu]", "g"); // cursor moves, clears
// Stray control chars (keep \n=0a \t=09). MUST skip ESC=0x1b so the SGR colour loop
// below can still see colour codes — stripping ESC here would kill all colouring.
const CTRL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001a\\u001c-\\u001f\\u007f]", "g");
const SGR_RE = new RegExp(ESC + "\\[([0-9;]*)m", "g"); // colour codes

/** Parse text with ANSI SGR colour codes into styled span nodes (strips OSC/cursor/control). */
export function parseAnsi(text: string): ReactNode[] {
  const cleaned = text.replace(OSC_RE, "").replace(CSI_NON_SGR_RE, "").replace(CTRL_RE, "");
  const out: ReactNode[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  let key = 0;
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushRun = (str: string) => {
    if (!str) return;
    const cls = styleClass(style);
    out.push(
      cls ? (
        <span key={key++} className={cls}>
          {str}
        </span>
      ) : (
        <span key={key++}>{str}</span>
      )
    );
  };
  while ((m = SGR_RE.exec(cleaned)) !== null) {
    pushRun(cleaned.slice(last, m.index));
    style = applySgr(style, m[1] ?? "");
    last = SGR_RE.lastIndex;
  }
  pushRun(cleaned.slice(last));
  return out;
}

/** Memoized so only changed text re-parses — settled output isn't re-parsed on every
 *  streamed chunk (callers should cap entry size so a parse stays bounded). */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const nodes = useMemo(() => parseAnsi(text), [text]);
  return <>{nodes}</>;
});
