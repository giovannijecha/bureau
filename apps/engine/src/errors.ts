// Engine error type with an HTTP status, so the HTTP layer can map failures
// (404 not found, 409 conflict, …) without leaking internals. Lives in its own
// module so both the orchestrator and the project registry can throw it without
// an import cycle.

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly status = 500
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
