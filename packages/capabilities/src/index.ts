// @bureau/capabilities — stateless capability workers.
// Phase 1: only `edit` is implemented. Others are stubs in the registry.
// Capabilities never know which provider/auth is in use.

export type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
export { CapabilityRegistry } from "./registry.js";
export { EditCapability, runAgenticFileWorker, buildEditPrompt, summarize, EDIT_TOOLS, type EditCapabilityDeps, type AgenticWorkerOptions } from "./edit.js";
export { DocumentCapability, type DocumentCapabilityDeps } from "./document.js";
export { ReviewCapability, buildReviewPrompt, REVIEW_TOOLS, type ReviewCapabilityDeps } from "./review.js";
export { PlanCapability, buildPlanPrompt, PLAN_TOOLS, type PlanCapabilityDeps } from "./plan.js";
export { TestCapability, DEFAULT_TEST_TIMEOUT_MS, type TestCapabilityDeps } from "./test.js";
export { defaultCommandRunner, type CommandRunner, type CommandResult } from "./run-command.js";
