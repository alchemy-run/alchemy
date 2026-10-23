/**
 * Rule sets for `oxlint.config.ts`. Rule ids use the plugin name `alchemy-domain`.
 *
 * - `domainRules`: every rule, for the domain package's source (enable it with
 *   `overrides[].files`, e.g. `packages/domain/src/**`).
 * - `serverRules`: the rules that also hold where the model is hosted (the
 *   server package, tests): provide one Layer once, redact secrets.
 */
type Severity = "error" | "warn";

const prefix = (rules: Record<string, Severity>): Record<string, Severity> =>
  Object.fromEntries(
    Object.entries(rules).map(([name, level]) => [`alchemy-domain/${name}`, level]),
  );

export const domainRules: Record<string, Severity> = prefix({
  "domain-imports": "error",
  "pure-decide-evolve": "error",
  "evolve-only-applies": "error",
  "rejects-listed": "error",
  "no-throw": "error",
  "no-cross-aggregate-import": "error",
  "deterministic-command-ids": "error",
  "policy-no-saga-wait": "error",
  "block-file-name": "warn",
  "one-block-per-file": "warn",
  "aggregate-id-file": "warn",
  "relative-import-extension": "warn",
  "no-barrel-file": "warn",
  "story-coverage": "warn",
  "redacted-secrets": "error",
  "no-chained-provide": "error",
});

export const serverRules: Record<string, Severity> = prefix({
  "redacted-secrets": "error",
  "no-chained-provide": "error",
});
