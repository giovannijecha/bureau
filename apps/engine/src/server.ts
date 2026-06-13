// Bureau engine — persistent Node daemon.
// HTTP + WebSocket server. Orchestrates Iris, tasks, capabilities.
// TODO: implement in Phase 2 (HTTP routes) and Phase 3 (WebSocket events).

console.log("Bureau engine stub — not yet implemented.");

// Planned structure:
// - HTTP POST /api/messages       → receive chat from panel → hand to Iris
// - HTTP GET  /api/tasks          → list tasks (TaskSummaryDto[])
// - HTTP GET  /api/tasks/:id      → task detail
// - HTTP POST /api/gates/:id/decide → human gate decision (GateDecisionRequestDto)
// - WS  /ws                       → push WsEvents to panel
