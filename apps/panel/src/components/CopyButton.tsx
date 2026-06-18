"use client";

// Copy-to-clipboard with a transient confirmation toast. Used on Iris's code blocks,
// commit hashes, and any other snippet worth lifting out of the panel. Falls back to a
// toast error if the browser denies clipboard access (it shouldn't on localhost).

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useToast } from "./Toast";
import { cn } from "../lib/utils";

export function CopyButton({
  text,
  label = "Copy",
  toastLabel = "Copied to clipboard",
  className,
}: {
  text: string;
  label?: string;
  toastLabel?: string;
  className?: string | undefined;
}) {
  const { success, error } = useToast();
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      // navigator.clipboard is undefined outside a secure context (https/localhost); treat
      // that as a real failure rather than a silent no-op that falsely reports success.
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      success(toastLabel);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      error("Couldn’t copy", "Clipboard needs a secure (https or localhost) context.");
    }
  }

  return (
    <button
      onClick={onCopy}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur transition-colors hover:text-foreground",
        className
      )}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
