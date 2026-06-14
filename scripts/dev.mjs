// One-command dev: run the engine + panel together with prefixed output.
// Usage: `pnpm build` once, then `node scripts/dev.mjs` (or `pnpm dev`).
// The engine auto-loads apps/engine/.env; the panel reads apps/panel/.env(.local).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

const procs = [
  { name: "engine", color: "\x1b[36m", cmd: process.execPath, args: [join(root, "apps/engine/dist/server.js")], cwd: join(root, "apps/engine") },
  { name: "panel ", color: "\x1b[35m", cmd: isWin ? "pnpm.cmd" : "pnpm", args: ["--filter", "@bureau/panel", "dev"], cwd: root },
];

const children = procs.map(({ name, color, cmd, args, cwd }) => {
  const child = spawn(cmd, args, { cwd, env: process.env, shell: isWin });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream) =>
    stream.on("data", (d) => {
      for (const line of d.toString().split("\n")) if (line.trim()) process.stdout.write(prefix + line + "\n");
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => console.log(`${prefix}exited (${code})`));
  return child;
});

const shutdown = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
