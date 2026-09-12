import * as AI from "alchemy/AI";
import { Distillation } from "./Distillation.ts";
import { AwsEmulation } from "./AwsEmulation.ts";
import { CloudflareEmulation } from "./CloudflareEmulation.ts";

/**
 * PROVIDER ENGINEERING — building, maintaining, and testing a cloud
 * provider in alchemy: the resource contract, its bindings, the
 * reconciler, the typed SDK it calls, and the live tests that prove it.
 * The per-service inner loop of the repository's root `AGENTS.md`, as
 * the shape a change or a review must hold every time. Activated when
 * a change touches `packages/alchemy/src/{Cloud}/{Service}/` or its
 * tests. The SDK side is {@link Distillation}, the local-emulator side
 * {@link AwsEmulation} — named here by `.source`, activated on their own.
 */
export class ProviderEngineering extends AI.Skill<ProviderEngineering>(
  import.meta,
)("ProviderEngineering") {}

export const ProviderEngineeringGeneral = ProviderEngineering.make`
  # Engineering a provider in alchemy

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
  distilled SDK's type-level union, handled with \`Effect.catchTag\` /
  \`Effect.retry({ while: (e) => e._tag === … })\` — fully inferred, no
  casts. An error the union does not name is not handled in alchemy at
  all: it is a turn of the loop in ${Distillation.source} — patch the
  service model, regenerate, handle the typed tag. A provider change
  that touched the SDK is therefore two pull requests, and the alchemy
  side's submodule pin must point at its companion.

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
  \`Alchemy.remote()\` opt-out. The local physics are their own craft:
  for AWS the same reconciler runs against the floci emulator, so the
  emulation is part of the resource (${AwsEmulation.source}); for
  Cloudflare the local variant is a second provider over the in-tree
  workerd runtime (${CloudflareEmulation.source}). Entitlement-gated
  lifecycles keep an ungated probe asserting the typed rejection and
  skipIf-gate the rest behind an env var.`;
