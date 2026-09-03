import * as AI from "alchemy/AI";
import { distilled, nameOf } from "../github/Repos.ts";
import { FindCompanions } from "../review/Companions.ts";

/**
 * How the org works in DISTILLED — the SDK factory alchemy's providers
 * call, pinned as a submodule at `distilled/` and one unit with the
 * alchemy repository: a provider change is usually a change here
 * first. Activated when a change touches `distilled/`, a provider's
 * error handling, or a companion pull request in
 * `alchemy-run/distilled`.
 */
export class DistilledGuidance extends AI.Skill<DistilledGuidance>(
  import.meta,
)("DistilledGuidance") {}

export const DistilledGuidanceGeneral = DistilledGuidance.make`
  # Working in distilled

  ${nameOf(distilled)} is a Smithy-based SDK FACTORY: every provider
  package (\`distilled/packages/{cloud}\`) converts its vendor spec into
  Smithy 2.0 models (one per service), applies a JSON Patch chain to
  each, and compiles the patched model into an Effect SDK module at
  \`src/services/{service}.ts\`. Alchemy's providers import those
  modules; the typed error union of every operation is what makes
  \`Effect.catchTag\` in a reconciler possible. In the alchemy tree it
  is a SUBMODULE pinned by commit — a session's checkout holds it as a
  worktree of the shared \`.git/modules/distilled\`; never run \`git
  submodule update\` inside a session tree.

  ## Never edit the generated SDK

  \`src/services/*.ts\` is OUTPUT — regeneration overwrites it. Anything
  wrong in the SDK (a missing error, a wrong request or response
  schema, a misnamed operation or member) is fixed with an RFC 6902
  JSON Patch under \`distilled/packages/{cloud}/patches/{service}/\`
  (files shaped \`{ "description", "patches": [ops] }\`, applied in
  filename order, \`*.manual.json\` last), then a regenerate of THAT
  service only:

  - Cloudflare and every OpenAPI-sourced provider:
    \`cd distilled/packages/{cloud} && bun scripts/generate.ts
    --resource {service} && pnpm exec oxfmt src/services/{service}.ts\`
  - AWS layers typed-error metadata over the official Smithy models in
    ONE schema file per service, \`patches/{service}.json\` (error
    categories, aliases, synthetic errors with message matchers):
    \`cd distilled/packages/aws && bun scripts/generate.ts --sdk
    {service}\`.

  A patch whose target path is stale WARNS and is skipped; a malformed
  patch FAILS the run. Either is a bug in the patch — fix it; never
  leave a red generate. Alchemy's tests resolve distilled from source
  (\`src/*.ts\`), so a regenerated service is test-visible at once —
  nothing to rebuild, nothing to wait for.

  ## Patches address the model, not the TypeScript

  Shape IDs are \`com.{cloud}.{service}#Name\` and member names are
  WIRE names (snake_case); the camelCase surface is derived at codegen.
  A typed error is a structure with the \`smithy.api#error\` trait and
  an \`errorMatchers\` trait (match the vendor's error \`code\` when one
  exists; else \`status\` plus a \`message\` matcher — the most specific
  matcher wins) added to the operation's \`errors\` list (\`.../errors/-\`
  when the list already exists). Tags are resource-specific
  (\`WidgetNotFound\`), never a bare \`NotFound\`. An unmatched error in
  alchemy — an \`Unknown*Error\`, a check on \`.status\`, a duck-typed
  \`_tag\` predicate, a widening cast — is ALWAYS a patch here, never a
  catch there.

  ## The companion pull request

  A provider change in alchemy that touches the SDK is TWO pull
  requests: this one, opened from a branch of the SAME NAME in
  ${nameOf(distilled)} (the patches and the regenerated service), and
  the alchemy one, whose submodule pin points at it — the head commit
  until the companion merges, its merge commit after. Publish the
  companion first; in the alchemy pull request, name it and say what
  the pin is. Reviewing, \`git ls-tree HEAD distilled\` in the
  checkout shows the pinned commit, and ${FindCompanions.source}
  finds the companion by branch name; a pin at some unrelated commit,
  or a companion the alchemy side never mentions, is a problem to
  name. Neither side is complete without the other.`;
