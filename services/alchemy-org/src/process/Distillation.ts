import * as AI from "alchemy/AI";
import { distilled, nameOf } from "../github/Repos.ts";
import { FindCompanions } from "../review/Companions.ts";

/**
 * DISTILLATION — the flywheel that produces alchemy's cloud coverage:
 * build a resource or binding in alchemy, test it live against the real
 * cloud, and feed every API mismatch the test surfaces — an unmatched
 * error, a wrong request or response schema — back into
 * `alchemy-run/distilled` as a patch, regenerate, test again. The SDK
 * improves for every consumer; that is the loop's output, not the
 * resource alone. One unit across two repositories, pinned by the
 * submodule at `distilled/`. Activated when a change adds or extends a
 * provider, touches `distilled/`, handles an SDK error, or is a
 * companion pull request in distilled.
 */
export class Distillation extends AI.Skill<Distillation>(import.meta)(
  "Distillation",
) {}

export const DistillationGeneral = Distillation.make`
  # Distillation

  Alchemy's coverage of a cloud is DISTILLED, not written: a resource
  or binding is implemented in alchemy and tested against the real
  cloud, and every mismatch the test surfaces between the cloud's
  behavior and the SDK's types — an error the union does not name, a
  status the SDK does not expect, a request or response shape that is
  wrong — is fed back into ${nameOf(distilled)} as a patch to the
  service's model, the service is regenerated, and the test runs again.
  The loop ends when the test is green over a fully typed SDK. The
  patch is the point: it improves the SDK for every future consumer,
  where a catch in alchemy would have fixed one call site and hidden
  the gap.

  ## The loop

  1. Implement the resource or binding against the distilled service
     module (\`distilled/packages/{cloud}/src/services/{service}.ts\`).
  2. Run its live test. Read the failure for what the SDK got wrong:
     an \`Unknown*Error\`, an out-of-union status, a schema decode
     failure, a member the wire has that the type lacks.
  3. Patch the SERVICE MODEL — never the consumer. \`Effect.catchTag\`
     that fails to type-check is the signal; checking \`.status\`, a
     duck-typed \`_tag\` predicate, or a widening cast in alchemy is
     the loop being skipped, and a problem to name wherever it appears.
  4. Regenerate that service only. Alchemy's tests resolve distilled
     from source (\`src/*.ts\`), so the regenerated module is
     test-visible at once — nothing to rebuild, nothing to wait for.
  5. Handle the now-typed tag in alchemy; run the test again.

  ## How distilled is built

  ${nameOf(distilled)} is a Smithy-based SDK factory. Every provider
  package converts its vendor spec into Smithy 2.0 models (one per
  service), applies an RFC 6902 JSON Patch chain to each model, and
  compiles the patched model into an Effect SDK module at
  \`src/services/{service}.ts\`. That module is OUTPUT — regeneration
  overwrites it; never edit it. Patches live under
  \`distilled/packages/{cloud}/patches/{service}/\` as files shaped
  \`{ "description", "patches": [ops] }\`, applied in filename order
  with \`*.manual.json\` last. Patches address the MODEL: shape IDs are
  \`com.{cloud}.{service}#Name\` and member names are wire names
  (snake_case) — the camelCase surface is derived at codegen. A typed
  error is a structure with the \`smithy.api#error\` trait and an
  \`errorMatchers\` trait (match the vendor's error \`code\` when one
  exists, else \`status\` plus a \`message\` matcher; the most specific
  wins), added to the operation's \`errors\` list (\`.../errors/-\` when
  the list exists). Tags are resource-specific — \`WidgetNotFound\`,
  never a bare \`NotFound\`.

  Regenerate one service, from its package:
  \`bun scripts/generate.ts --resource {service} && pnpm exec oxfmt
  src/services/{service}.ts\`. AWS is the one exception in dialect:
  it layers typed-error metadata over the official Smithy models in
  one schema file per service, \`patches/{service}.json\` (error
  categories, aliases, synthetic errors with message matchers),
  regenerated with \`bun scripts/generate.ts --sdk {service}\`. A patch
  whose target path is stale WARNS and is skipped; a malformed patch
  FAILS the run — either is a bug in the patch. Never leave a red
  generate. In a session's checkout distilled is a worktree of the
  shared \`.git/modules/distilled\`; never run \`git submodule update\`
  there.

  ## Two pull requests, one change

  A change that patched the SDK ships as TWO pull requests from a
  branch of the SAME NAME: the companion in ${nameOf(distilled)} (the
  patches and the regenerated service) and the alchemy one, whose
  submodule pin points at it — the companion's head commit until it
  merges, its merge commit after. Publish the companion first; in the
  alchemy pull request, name it and state the pin. Reviewing, \`git
  ls-tree HEAD distilled\` in the checkout shows the pinned commit and
  ${FindCompanions.source} finds the companion by branch name; a pin
  at some unrelated commit, or a companion the alchemy side never
  mentions, is a problem to name. Neither side is complete without the
  other.`;
