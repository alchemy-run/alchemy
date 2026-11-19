import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ConnectSandbox } from "./ConnectSandbox.ts";
import { makeAccess } from "./DaytonaBindings.ts";
import type { Sandbox } from "./Sandbox.ts";
import { makeConnectedSandbox } from "./SandboxClient.ts";

/** {@link ConnectSandbox} over Daytona's HTTP API; works on any host. */
export const ConnectSandboxHttp = Layer.effect(
  ConnectSandbox,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* (sandbox: Sandbox) {
      const { authorize, organizationId } = yield* access(`${sandbox.LogicalId}Connect`, [
        "write:sandboxes",
        "delete:sandboxes",
      ]);
      const sandboxId = yield* sandbox.sandboxId;
      const name = yield* sandbox.name;
      const toolboxProxyUrl = yield* sandbox.toolboxProxyUrl;
      // The sandbox's identity resolves at runtime, on each call.
      const identity = Effect.all({ id: sandboxId, name, toolboxProxyUrl });
      return makeConnectedSandbox(identity, organizationId, authorize);
    });
  }),
);
