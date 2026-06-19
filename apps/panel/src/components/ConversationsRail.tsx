"use client";

import { Plus, MessageSquare, Trash2 } from "lucide-react";
import type { Conversation } from "@bureau/contracts";
import { cn } from "../lib/utils";

// The ChatGPT-style left rail: new chat + the list of conversations.
export function ConversationsRail({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  projectLabel,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** "owner/name" for a thread's project, or null to hide it (e.g. single-project setups). */
  projectLabel?: (projectId: string | null) => string | null;
}) {
  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r bg-background/40">
      <div className="p-2.5">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No conversations yet.</p>
        ) : (
          <div className="space-y-0.5">
            {conversations.map((c) => {
              const active = c.id === activeId;
              const proj = projectLabel?.(c.projectId) ?? null;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                    active ? "bg-accent" : "hover:bg-accent/50"
                  )}
                >
                  <button onClick={() => onSelect(c.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <MessageSquare className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{c.title}</span>
                      {proj && <span className="truncate text-[10px] leading-tight text-muted-foreground">{proj}</span>}
                    </span>
                  </button>
                  <button
                    onClick={() => onDelete(c.id)}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
