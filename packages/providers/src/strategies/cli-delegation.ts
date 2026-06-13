// CLI-delegation auth strategy. "Available" means the local `claude` CLI is on
// PATH and runnable — no API key needed; the CLI carries its own credentials.
// The probe is injectable so this is unit-testable without the CLI installed.

import { spawnSync } from "node:child_process";
import type { AuthStrategy } from "../provider.js";

export type CliProbe = (cli: string) => boolean;

const defaultProbe: CliProbe = (cli) => {
  try {
    const res = spawnSync(cli, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return res.status === 0;
  } catch {
    return false; // ENOENT etc. — CLI not installed
  }
};

export class CliDelegationStrategy implements AuthStrategy {
  readonly kind = "cli-delegation" as const;

  constructor(
    private readonly cli = "claude",
    private readonly probe: CliProbe = defaultProbe
  ) {}

  isAvailable(): boolean {
    return this.probe(this.cli);
  }

  /** The CLI command name/path this strategy delegates to. */
  cliCommand(): string {
    return this.cli;
  }
}
