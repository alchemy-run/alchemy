/**
 * The Durable Object that OWNS the sandbox container — containers
 * attach to DOs, and this one is deliberately a singleton (the org
 * addresses `getByName("org")`): ONE machine hosts every run's
 * worktree, exactly like the local workspace root, so the engineer
 * and reviewer keyed by the same issue share one checkout.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {
  OrgSandbox,
  type SandboxCall,
  type SandboxPush,
} from "./Sandbox.ts";

export default class SandboxHost extends Cloudflare.DurableObject<SandboxHost>()(
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
    Effect.provide(
      // the container clones from and pushes to github.com
      Cloudflare.Containers.layer(OrgSandbox, { enableInternet: true }),
    ),
  ),
) {}
