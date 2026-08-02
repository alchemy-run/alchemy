/**
 * The Durable Object that OWNS the sandbox container — containers
 * attach to DOs, and this one is deliberately a singleton (the org
 * addresses `getByName("org")`): ONE machine hosts every run's
 * worktree, exactly like the local workspace root, so the engineer
 * and reviewer keyed by the same issue share one checkout.
 */
import * as Containers from "alchemy/Cloudflare/Containers";
import * as Workers from "alchemy/Cloudflare/Workers";
import * as Effect from "effect/Effect";
import { OrgSandbox, type SandboxCall, type SandboxPush } from "./Sandbox.ts";

export default class SandboxHost extends Workers.DurableObject<SandboxHost>()(
  "SandboxHost",
  Effect.gen(function* () {
    const container = yield* OrgSandbox;
    return Effect.gen(function* () {
      return {
        call: (input: SandboxCall) => container.call(input),
        push: (input: SandboxPush) => container.push(input),
      };
    });
  }).pipe(
    Effect.provide(Containers.layer(OrgSandbox, { enableInternet: true })),
  ),
) {}
