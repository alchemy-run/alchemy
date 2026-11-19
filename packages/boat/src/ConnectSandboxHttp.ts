import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ApiKeyAction } from "./ApiKey.ts";
import { bindBoat } from "./BoatBindings.ts";
import { ConnectSandbox } from "./ConnectSandbox.ts";
import { makeConnectedSandbox } from "./internal/SandboxHandle.ts";
import type { Sandbox } from "./Sandbox.ts";

/** What a `ConnectSandbox` host may do, on its one sandbox. */
const CONNECT_SANDBOX_ACTIONS: ApiKeyAction[] = [
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "exec",
  "file.read",
  "file.write",
  "host",
  "snapshot.read",
  "snapshot.write",
];

/** `DevBox` → `DEV_BOX`, for the env var that carries its key. */
const envSuffix = (logicalId: string) =>
  logicalId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();

/**
 * HTTP implementation of {@link ConnectSandbox}: Boat's REST API with a key
 * that reaches only the bound sandbox. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const devBox = yield* Boat.ConnectSandbox(DevBox);
 *   // ...
 * }).pipe(Effect.provide(Boat.ConnectSandboxHttp))
 * ```
 *
 * @layer
 * @product Sandbox
 * @provides Boat.ConnectSandbox
 */
export const ConnectSandboxHttp = Layer.succeed(
  ConnectSandbox,
  Effect.fn("Boat.ConnectSandbox")(function* (sandbox: Sandbox) {
    const auth = yield* bindBoat(
      `${sandbox.LogicalId}Key`,
      `BOAT_${envSuffix(sandbox.LogicalId)}_KEY`,
      { actions: CONNECT_SANDBOX_ACTIONS, sandboxIds: [sandbox.sandboxId] },
    );
    const sandboxId = yield* (sandbox.sandboxId as Output.Output<string, never>).asEffect();
    return makeConnectedSandbox(auth, sandboxId);
  }),
);
