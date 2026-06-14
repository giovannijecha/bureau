// @bureau/capabilities — stateless capability workers.
// Phase 1: only `edit` is implemented. Others are stubs in the registry.
// Capabilities never know which provider/auth is in use.

export type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
export { CapabilityRegistry } from "./registry.js";
export { EditCapability, buildEditPrompt, summarize, EDIT_TOOLS, type EditCapabilityDeps } from "./edit.js";
