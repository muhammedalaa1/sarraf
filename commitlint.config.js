// Conventional Commits for commit messages (lefthook commit-msg) and PR titles (.github/workflows/pr-title.yml).
// Format: type(scope): subject, e.g. "fix(kashier): sort keys before signing". The scope is optional.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"],
    ],
    "scope-enum": [
      2,
      "always",
      [
        // published packages
        "core",
        "paymob",
        "kashier",
        "fawry",
        "express",
        "testing",
        // apps and tooling
        "dashboard",
        "docs",
        "examples",
        "scripts",
        "ci",
        // dependency updates (Dependabot uses deps / deps-dev)
        "deps",
        "deps-dev",
      ],
    ],
  },
};
