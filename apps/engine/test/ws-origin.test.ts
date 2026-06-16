import { describe, it, expect } from "vitest";
import { sameMachineOrigin } from "../src/ws-origin.js";

describe("sameMachineOrigin — WebSocket cross-site (CSWSH) guard", () => {
  it("allows the local panel's browser origins", () => {
    expect(sameMachineOrigin("http://localhost:3000")).toBe(true);
    expect(sameMachineOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(sameMachineOrigin("http://[::1]:3000")).toBe(true);
    expect(sameMachineOrigin("https://localhost")).toBe(true);
  });

  it("allows a missing/empty Origin (non-browser client — no cross-site risk)", () => {
    expect(sameMachineOrigin(undefined)).toBe(true);
    expect(sameMachineOrigin("")).toBe(true);
  });

  it("REJECTS a remote website's Origin — the RCE vector it blocks", () => {
    expect(sameMachineOrigin("https://evil.com")).toBe(false);
    expect(sameMachineOrigin("http://attacker.example")).toBe(false);
    // Subdomain / suffix tricks must NOT slip through.
    expect(sameMachineOrigin("http://localhost.evil.com")).toBe(false);
    expect(sameMachineOrigin("http://127.0.0.1.evil.com")).toBe(false);
    expect(sameMachineOrigin("http://notlocalhost")).toBe(false);
  });

  it("rejects a malformed Origin", () => {
    expect(sameMachineOrigin("not a url")).toBe(false);
    expect(sameMachineOrigin("://broken")).toBe(false);
  });
});
