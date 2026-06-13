// @bureau/providers — model adapters + auth strategies.
// Capabilities never import specific providers — always via the Provider interface.

export type {
  Provider,
  AuthStrategy,
  AuthStrategyKind,
  Message,
  ProviderResponse,
} from "./provider.js";
export { ProviderRegistry } from "./registry.js";

// Adapters
export {
  AnthropicProvider,
  DEFAULT_MODEL,
  splitMessages,
  toProviderResponse,
  type AnthropicProviderOptions,
} from "./anthropic.js";
export {
  ClaudeCliProvider,
  defaultCliRunner,
  renderCliPrompt,
  parseCliJson,
  type CliRunner,
  type CliResult,
  type ClaudeCliProviderOptions,
} from "./claude-cli.js";

// Auth strategies
export { ApiKeyStrategy } from "./strategies/api-key.js";
export { CliDelegationStrategy, type CliProbe } from "./strategies/cli-delegation.js";
export { OAuthStrategy } from "./strategies/oauth.stub.js";
