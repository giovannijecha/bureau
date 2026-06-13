import { Bell } from "lucide-react";

export function Header() {
  return (
    <header className="flex h-16 shrink-0 items-center justify-end gap-3 border-b bg-background px-6">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Notifications"
      >
        <Bell className="h-[18px] w-[18px]" />
      </button>
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          CEO
        </div>
        <span className="hidden text-sm font-medium sm:inline">Giovanni</span>
      </div>
    </header>
  );
}
