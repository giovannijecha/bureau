import { cn } from "../lib/utils";

/** A live character counter that only appears as a field fills up (past ~70%) and
 *  turns red once it overflows the limit — quiet when there's nothing to warn about. */
export function CharCount({ value, max, className }: { value: number; max: number; className?: string }) {
  if (value < max * 0.7) return null;
  const over = value > max;
  return (
    <span className={cn("tabular-nums text-[11px]", over ? "font-medium text-destructive" : "text-muted-foreground", className)}>
      {value.toLocaleString()} / {max.toLocaleString()}
    </span>
  );
}
