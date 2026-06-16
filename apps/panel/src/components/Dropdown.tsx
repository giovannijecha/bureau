"use client";

// A small custom select — button + popover list, theme-styled, click-outside. Replaces
// native <select> (whose OS blue highlight looks out of place in a dark dashboard).
//
// The popover is rendered in a PORTAL (document.body) at fixed coordinates, so it is
// NEVER clipped by an ancestor's `overflow-hidden`/`overflow-auto` (e.g. a card or a
// scroll container) — the bug that made the Operations op-picker render half cut off.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useAnchoredPopover } from "../lib/useAnchoredPopover";
import { cn } from "../lib/utils";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  hint?: string;
}

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  leftIcon,
  className,
  buttonClassName,
  align = "left",
  placeholder,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  leftIcon?: ReactNode;
  className?: string;
  buttonClassName?: string;
  align?: "left" | "right";
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(open, btnRef, { align });

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return; // popover is portaled
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent",
          buttonClassName
        )}
      >
        {leftIcon}
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? placeholder ?? "Select"}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.minWidth, maxHeight: pos.maxHeight }}
            className="z-50 w-max min-w-[12rem] max-w-[22rem] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
          >
            {options.map((o) => {
              const selected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                    selected && "bg-accent/60"
                  )}
                >
                  {o.icon && <span className="mt-px shrink-0">{o.icon}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.label}</span>
                    {o.hint && <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground">{o.hint}</span>}
                  </span>
                  {selected && <Check className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}
