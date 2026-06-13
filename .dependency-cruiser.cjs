/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-no-bureau-runtime",
      comment: "core must not import any other @bureau/* package at runtime.",
      severity: "error",
      from: { path: "^packages/core" },
      to: {
        path: "^packages/(db|providers|vcs|mind|capabilities|contracts)",
      },
    },
    {
      name: "contracts-no-bureau-runtime",
      comment: "contracts must not import any other @bureau/* package at runtime.",
      severity: "error",
      from: { path: "^packages/contracts" },
      to: {
        path: "^packages/(core|db|providers|vcs|mind|capabilities)",
      },
    },
    {
      name: "panel-contracts-only",
      comment: "panel may only import @bureau/contracts from bureau packages.",
      severity: "error",
      from: { path: "^apps/panel" },
      to: {
        path: "^packages/(core|db|providers|vcs|mind|capabilities)",
      },
    },
    {
      name: "db-core-only",
      comment: "db may only import core from bureau packages.",
      severity: "error",
      from: { path: "^packages/db" },
      to: {
        path: "^packages/(providers|vcs|mind|capabilities|contracts)",
      },
    },
    {
      name: "vcs-core-only",
      comment: "vcs may only import core from bureau packages.",
      severity: "error",
      from: { path: "^packages/vcs" },
      to: {
        path: "^packages/(db|providers|mind|capabilities|contracts)",
      },
    },
    {
      name: "mind-core-only",
      comment: "mind may only import core from bureau packages.",
      severity: "error",
      from: { path: "^packages/mind" },
      to: {
        path: "^packages/(db|providers|vcs|capabilities|contracts)",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
