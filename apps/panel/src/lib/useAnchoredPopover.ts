"use client";

// Position a portaled popover at a trigger's live coordinates (position: fixed), so it
// is NEVER clipped by an ancestor's overflow-hidden/overflow-auto. Opens downward, fits
// its height to the space below, clamps to the viewport, and repositions on capture-phase
// scroll (any ancestor) + resize. The consumer renders the popover via createPortal and
// owns click-outside (it must check the trigger AND the portaled popover refs).

import { useLayoutEffect, useState, type RefObject } from "react";

export interface PopoverPos {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  opts?: { align?: "left" | "right"; gap?: number; estWidth?: number }
): PopoverPos | null {
  const align = opts?.align ?? "left";
  const gap = opts?.gap ?? 6;
  const estWidth = opts?.estWidth ?? 264;
  const [pos, setPos] = useState<PopoverPos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = anchorRef.current?.getBoundingClientRect();
      if (!b) return;
      const maxHeight = Math.min(288, Math.max(120, window.innerHeight - b.bottom - gap - 8));
      let left = align === "right" ? b.right - estWidth : b.left;
      // Clamp horizontally so a trigger near either edge never pushes the popover off-screen.
      left = Math.max(8, Math.min(left, window.innerWidth - estWidth - 8));
      setPos({ top: b.bottom + gap, left, minWidth: b.width, maxHeight });
    };
    place();
    window.addEventListener("scroll", place, true); // capture → follows scroll in ANY ancestor
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, gap, estWidth, anchorRef]);

  return open ? pos : null;
}
