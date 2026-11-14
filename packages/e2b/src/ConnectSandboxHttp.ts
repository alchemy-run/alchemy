import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { ConnectSandbox } from "./ConnectSandbox.ts";
import { bindE2B } from "./E2BBindings.ts";
import { makeConnectedSandbox } from "./internal/SandboxHandle.ts";
import type { Sandbox } from "./Sandbox.ts";

/**
 * HTTP implementation of {@link ConnectSandbox}: E2B's control plane with
 * the host's key, and envd inside the sandbox with the sandbox's own token.
 * Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const devBox = yield* E2B.ConnectSandbox(DevBox);
 *   // ...
 * }).pipe(Effect.provide(E2B.ConnectSandboxHttp))
 * ```
 *
 * @layer
 * @product Sandbox
 * @provides E2B.ConnectSandbox
 */
export const ConnectSandboxHttp = Layer.succeed(
  ConnectSandbox,
  Effect.fn("E2B.ConnectSandbox")(function* (sandbox: Sandbox) {
    const auth = yield* bindE2B;
    const sandboxId = yield* (sandbox.sandboxId as Output.Output<string, never>).asEffect();
    const trafficToken = yield* (
      sandbox.trafficAccessToken as Output.Output<Redacted.Redacted<string> | undefined, never>
    ).asEffect();
    return makeConnectedSandbox(auth, sandboxId, trafficToken);
  }),
);
