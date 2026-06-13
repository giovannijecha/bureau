// Task domain types — the heart of Bureau.
// Pure data shapes: no I/O, no framework deps, fully unit-testable.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type TaskId = string & { readonly __brand: "TaskId" };
export type StepId = string & { readonly __brand: "StepId" };
export type GateId = string & { readonly __brand: "GateId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export type CapabilityKind = "plan" | "edit" | "test" | "review" | "document";

export type GateKind = "plan_review" | "diff_review" | "pr_approval";

export type HumanDecision = "approved" | "rejected" | "request_changes";

// ---------------------------------------------------------------------------
// Acceptance criterion
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly verified: boolean;
}

// ---------------------------------------------------------------------------
// Gate — a human-review checkpoint; only human decisions are accepted
// ---------------------------------------------------------------------------

export type GateStatus = "pending" | "open" | "approved" | "rejected";

export interface Gate {
  readonly id: GateId;
  readonly kind: GateKind;
  readonly status: GateStatus;
  /** ISO-8601 timestamp of the human decision, undefined until decided. */
  readonly decidedAt?: string;
  readonly decision?: HumanDecision;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Artifact — a file or diff produced by a capability
// ---------------------------------------------------------------------------

export type ArtifactKind = "diff" | "file" | "report" | "pr_url";

export interface Artifact {
  readonly id: ArtifactId;
  readonly kind: ArtifactKind;
  /** Path relative to the worktree root, or a URL for pr_url artifacts. */
  readonly ref: string;
  readonly producedByStep: StepId;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Decision log — append-only record of every state change and human choice
// ---------------------------------------------------------------------------

export type DecisionEntry =
  | { readonly type: "task_created"; readonly at: string; readonly goal: string }
  | { readonly type: "step_started"; readonly at: string; readonly stepId: StepId }
  | { readonly type: "step_completed"; readonly at: string; readonly stepId: StepId }
  | { readonly type: "step_failed"; readonly at: string; readonly stepId: StepId; readonly reason: string }
  | { readonly type: "gate_opened"; readonly at: string; readonly gateId: GateId }
  | { readonly type: "gate_decided"; readonly at: string; readonly gateId: GateId; readonly decision: HumanDecision; readonly notes?: string }
  | { readonly type: "task_completed"; readonly at: string }
  | { readonly type: "task_aborted"; readonly at: string; readonly reason: string };

export type DecisionLog = readonly DecisionEntry[];

// ---------------------------------------------------------------------------
// Step — one unit of work delegated to a capability
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "running" | "completed" | "failed" | "blocked_on_gate";

export interface Step {
  readonly id: StepId;
  readonly capability: CapabilityKind;
  readonly description: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly status: StepStatus;
  readonly gateAfter?: GateId;
  readonly artifactIds: readonly ArtifactId[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
}

// ---------------------------------------------------------------------------
// Task — the persistent, inspectable unit of work
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "created"
  | "planning"
  | "executing"
  | "awaiting_human"
  | "completed"
  | "aborted";

export interface Task {
  readonly id: TaskId;
  readonly goal: string;
  readonly repoOwner: string;
  readonly repoName: string;
  /** worktree path on disk, set after VCS setup */
  readonly worktreePath?: string;
  readonly status: TaskStatus;
  readonly steps: readonly Step[];
  readonly gates: readonly Gate[];
  readonly artifacts: readonly Artifact[];
  readonly decisionLog: DecisionLog;
  readonly createdAt: string;
  readonly updatedAt: string;
}
