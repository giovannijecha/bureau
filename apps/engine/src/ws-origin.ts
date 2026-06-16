// WebSocket-upgrade Origin guard. A WebSocket connection is NOT bound by the browser's
// same-origin policy, so without this ANY website open in the CEO's browser could connect
// to ws://localhost/terminal and run arbitrary shell commands on this machine. The engine's
// upgrade dispatcher rejects any cross-site Origin before routing to the /ws or /terminal hub.

/** Is a WebSocket upgrade's Origin same-machine (the local panel) rather than a remote
 *  website? A missing Origin = a non-browser client (curl/CLI), allowed — it isn't subject
 *  to the cross-site risk this guards. A present, non-localhost Origin (a website) is
 *  rejected, blocking cross-site WebSocket hijacking of the shell/terminal channel. */
export function sameMachineOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true; // non-browser client
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, ""); // unbracket IPv6
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false; // malformed Origin → reject
  }
}
