import * as AI from "alchemy/AI";
import { DistilledGuidance } from "./DistilledGuidance.ts";
import { FlociGuidance } from "./FlociGuidance.ts";

/**
 * How a cloud PROVIDER is written in alchemy — resources, bindings, the
 * lifecycle, the SDK, the tests. Activated when a change touches
 * `packages/alchemy/src/{Cloud}/{Service}/`. The repository's root
 * `AGENTS.md` is the full text; this is the shape of it a review or a
 * change must hold, every time. The SDK side (distilled) and the
 * emulator side (floci) are their own skills, named here by `.source`.
 */
export class ProviderGuidance extends AI.Skill<ProviderGuidance>(import.meta)(
  "ProviderGuidance",
) {}

export const ProviderGuidanceGeneral = ProviderGuidance.make`
  # Providers in alchemy

  A resource's contract and provider live in ONE file,
  \`packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts\`; each
  capability (a \`Binding.Service\`) in its own file, split by access
  level (\`*Read\` / \`*Write\` / \`*ReadWrite\`, each with a native
  \`*Binding\` and a token-scoped \`*Http\` implementation) with the
  shared scaffolding un-exported from \`index.ts\`. Props declare plain
  types — never \`Input<T>\` — and every prop and attribute carries
  JSDoc: the docs are generated from it (\`pnpm docs:gen\`), never
  edited under \`website/\`. The runtime callable a binding returns
  requires \`Alchemy.RuntimeContext\`; init-time services (\`WorkerEnvironment\`,
  SDK clients) are resolved once at Layer construction and never leak
  onto it.

  ## The reconciler

  \`reconcile\` replaces create + update and MUST work for all three
  starts — greenfield (\`output\` and \`olds\` undefined), routine update
  (both defined), adoption (\`output\` defined, \`olds\` undefined) — as
  ONE flow: observe live cloud state, ensure the resource exists
  (tolerating AlreadyExists/Conflict as a race), sync each mutable
  aspect by diffing OBSERVED state against desired and applying only
  the delta, return fresh attributes. \`if (output === undefined)
  { create } else { update }\` is rename-and-branch, not reconciliation
  — a problem to name wherever it appears. Tags diff against observed
  cloud tags with \`diffTags\`, never against \`olds\`; internal tags brand
  every resource that supports them. Delete is idempotent: not-found is
  success. \`diff\` narrows \`Input<Props>\` with \`isResolved\` before
  touching a property, and \`no-op\` is an edge case, not a habit.

  ## Typed errors

  Every error an operation can produce is a tagged error in the
  distilled SDK's type-level union. An unmatched error (an
  \`Unknown*Error\`, a check on \`.status\`, a duck-typed \`_tag\`
  predicate, a widening cast) is fixed with a JSON Patch in distilled
  and a regenerate of that service — never a catch in alchemy.
  \`Effect.catchTag\` that fails to type-check is the signal to patch.
  A provider change therefore usually has a COMPANION pull request in
  distilled, and the alchemy side's submodule pin must point at it;
  the patch format, the regenerate commands, and the companion
  convention are ${DistilledGuidance.source} — activate it for the
  distilled side of the work.

  ## Effect only

  No \`async\`/\`await\`, no raw \`Promise\`, no \`node:fs\`/\`node:path\`/
  \`fetch\` in resource code or tests: \`FileSystem.FileSystem\`,
  \`Path.Path\`, \`HttpClient\`, \`Effect.sleep\`; sync Node APIs wrapped in
  \`Effect.sync\`. Never \`Effect.orDie\` in a lifecycle operation. Every
  retry is bounded (≤ 8–10 times, under ~60s total); nothing polls
  slower than ~90s — skipIf-gate instead. Effect 4 APIs
  (\`Effect.result\`, not \`Effect.either\`).

  ## Tests

  \`test/{Cloud}/{Service}/{Resource}.test.ts\` on \`test.provider\`,
  beginning AND ending with \`stack.destroy()\`, deterministic names
  (auto-naming or a constant — never \`Date.now()\`), out-of-band
  verification through distilled, a typed wait-until-gone, replacement
  coverage where a prop replaces. Runtime behavior is tested with a
  FIXTURE (a Worker/Lambda that binds the resource, driven over HTTP),
  never a mock. A resource with a local provider registers both
  variants with \`ProviderLayer.dual\` and ships a
  \`{Resource}.local.test.ts\` covering the local roundtrip and the
  \`Alchemy.remote()\` opt-out — for AWS the local variant is the same
  reconciler against the floci emulator, so the emulation is part of
  the resource (${FlociGuidance.source}). Entitlement-gated lifecycles
  keep an ungated probe asserting the typed rejection and skipIf-gate
  the rest behind an env var.`;
