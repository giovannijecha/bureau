import { describe, it, expect } from "vitest";
import { isSecretEnvName } from "../src/terminal.js";

describe("isSecretEnvName — terminal env-scrub", () => {
  it("strips Bureau's own credentials", () => {
    for (const k of ["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) {
      expect(isSecretEnvName(k)).toBe(true);
    }
  });

  it("strips common secret-shaped names (case-insensitive)", () => {
    for (const k of ["AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "MY_SERVICE_TOKEN", "DB_PASSWORD", "STRIPE_SECRET", "npm_token", "CLIENT_SECRET", "MY_PASSPHRASE"]) {
      expect(isSecretEnvName(k)).toBe(true);
    }
  });

  it("keeps benign env vars the shell needs", () => {
    for (const k of ["PATH", "HOME", "SHELL", "LANG", "TERM", "USER", "PWD", "TMPDIR"]) {
      expect(isSecretEnvName(k)).toBe(false);
    }
  });

  it("does NOT over-match non-secret names that merely contain a secret word", () => {
    // The secret word must be a whole segment — these are NOT secrets.
    for (const k of ["TOKENIZERS_PARALLELISM", "PRIMARY_KEY", "SIGNING_KEY", "PUBLIC_KEY"]) {
      expect(isSecretEnvName(k)).toBe(false);
    }
  });

  it("allows secret-shaped-but-safe names through (ssh agent / git askpass)", () => {
    for (const k of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "SSH_ASKPASS"]) {
      expect(isSecretEnvName(k)).toBe(false);
    }
  });
});
