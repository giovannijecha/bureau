import { AlertCircle } from "lucide-react";

/** Inline, field-level error message — sits directly under the input it refers to,
 *  so the reason is always in the user's field of view (not a detached toast). */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
