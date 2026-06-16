import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A short, GitHub-style relative time ("3 days ago", "2 months ago") from an ISO
 *  date. Falls back to the raw string when it isn't a parseable date. */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 45) return "just now";
  // Largest unit whose span fits within the elapsed seconds.
  const units: [secs: number, name: string][] = [
    [31_536_000, "year"],
    [2_592_000, "month"],
    [604_800, "week"],
    [86_400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [span, name] of units) {
    if (secs >= span) {
      const value = Math.floor(secs / span);
      return `${value} ${name}${value === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
