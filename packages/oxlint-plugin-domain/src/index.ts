/**
 * oxlint rules for `@alchemy.run/domain` models: the rules of the
 * `alchemy-domain` skill (`packages/domain/skills/alchemy-domain`), checked at
 * lint time.
 *
 * ```ts
 * // oxlint.config.ts
 * import { defineConfig } from "oxlint";
 * import { domainRules, serverRules } from "@alchemy.run/oxlint-plugin-domain/configs";
 *
 * export default defineConfig({
 *   jsPlugins: ["@alchemy.run/oxlint-plugin-domain"],
 *   overrides: [
 *     { files: ["packages/domain/src/**"], rules: domainRules },
 *     { files: ["packages/server/src/**"], rules: serverRules },
 *   ],
 * });
 * ```
 */
import { aggregateIdFile } from "./rules/aggregate-id-file.ts";
import { blockFileName } from "./rules/block-file-name.ts";
import { deterministicCommandIds } from "./rules/deterministic-command-ids.ts";
import { domainImports } from "./rules/domain-imports.ts";
import { evolveOnlyApplies } from "./rules/evolve-only-applies.ts";
import { noBarrelFile } from "./rules/no-barrel-file.ts";
import { noChainedProvide } from "./rules/no-chained-provide.ts";
import { noCrossAggregateImport } from "./rules/no-cross-aggregate-import.ts";
import { noThrow } from "./rules/no-throw.ts";
import { oneBlockPerFile } from "./rules/one-block-per-file.ts";
import { policyNoSagaWait } from "./rules/policy-no-saga-wait.ts";
import { pureDecideEvolve } from "./rules/pure-decide-evolve.ts";
import { redactedSecrets } from "./rules/redacted-secrets.ts";
import { rejectsListed } from "./rules/rejects-listed.ts";
import { relativeImportExtension } from "./rules/relative-import-extension.ts";
import { storyCoverage } from "./rules/story-coverage.ts";

export const rules = {
  "aggregate-id-file": aggregateIdFile,
  "block-file-name": blockFileName,
  "deterministic-command-ids": deterministicCommandIds,
  "domain-imports": domainImports,
  "evolve-only-applies": evolveOnlyApplies,
  "no-barrel-file": noBarrelFile,
  "no-chained-provide": noChainedProvide,
  "no-cross-aggregate-import": noCrossAggregateImport,
  "no-throw": noThrow,
  "one-block-per-file": oneBlockPerFile,
  "policy-no-saga-wait": policyNoSagaWait,
  "pure-decide-evolve": pureDecideEvolve,
  "redacted-secrets": redactedSecrets,
  "rejects-listed": rejectsListed,
  "relative-import-extension": relativeImportExtension,
  "story-coverage": storyCoverage,
};

const plugin = {
  meta: { name: "alchemy-domain" },
  rules,
};

export default plugin;
