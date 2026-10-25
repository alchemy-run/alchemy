/**
 * Rule sets for `oxlint.config.ts`. Rule ids use the plugin name `alchemy-domain`.
 *
 * - `domainRules`: the rules that read the model exactly, for the domain
 *   package's source (enable it with `overrides[].files`, e.g.
 *   `packages/domain/src/**`).
 * - `serverRules`: the rule that also holds where the model is hosted (the
 *   server package, tests): provide one Layer once.
 * - `strictRules`: rules that guess from names and text, so they can be wrong
 *   (`deterministic-command-ids`, `redacted-secrets`, `story-coverage`). They
 *   warn; add them to either set when the reports are worth the noise.
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
  "policy-no-saga-wait": "error",
  "no-chained-provide": "error",
  "block-file-name": "warn",
  "one-block-per-file": "warn",
  "aggregate-id-file": "warn",
  "relative-import-extension": "warn",
  "no-barrel-file": "warn",
});

export const serverRules: Record<string, Severity> = prefix({
  "no-chained-provide": "error",
});

export const strictRules: Record<string, Severity> = prefix({
  "deterministic-command-ids": "warn",
  "redacted-secrets": "warn",
  "story-coverage": "warn",
});
