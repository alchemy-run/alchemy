/**
 * agentOS on Rivet: a VM per actor for model-generated code, either embedded
 * in-process with `@rivet-dev/agentos-core` or hosted on Rivet Services with
 * `@rivet-dev/agentos`.
 *
 * A {@link Services} pool (`RivetDocker.ServicesPool`, …) already runs the
 * hosted agentOS actor in the `services` pool. {@link client} (exported as
 * `agentOsClient` from `@alchemy.run/rivet`) builds a typed RivetKit client
 * against that pool from the `Services` binding. For an embedded VM inside
 * your own Durable Object or RivetKit actor, call {@link AgentOs.create}
 * from `createVars` / the instance constructor.
 *
 * @see https://rivet.dev/docs/agent-os
 */
import { createAgentOsClient, type AgentOsClient } from "@rivet-dev/agentos";
import * as Output from "alchemy/Output";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Services, SERVICES_POOL } from "./Services.ts";

/**
 * Embedded agentOS: boot a VM in this process with `AgentOs.create()`, or a
 * sidecar with `AgentOs.createSidecar()`.
 */
export { AgentOs, AgentOsSidecar } from "@rivet-dev/agentos-core";
export type { AgentOsClient } from "@rivet-dev/agentos";
export { createAgentOsClient } from "@rivet-dev/agentos";

/** A client was built outside any runtime that has {@link Services}. */
export class AgentOsCalledOutsideRuntime extends Data.TaggedError(
  "Rivet.AgentOsCalledOutsideRuntime",
)<{
  readonly message: string;
}> {}

/**
 * A typed agentOS client for the Rivet Services pool that hosts it. Resolves
 * the control plane endpoint, token and namespace from {@link Services}, and
 * targets {@link SERVICES_POOL}. Use from any runtime that was given a
 * services pool Layer.
 *
 * **Example:** Call hosted agentOS from a Worker
 * ```typescript
 * const agentOs = yield* Rivet.agentOsClient;
 * const handle = agentOs.agentOS.getOrCreate(["session-1"]);
 * await handle.process.exec("uname -a");
 * ```
 *
 * **Example:** Embed a VM in a Durable Object
 * ```typescript
 * import { AgentOs } from "@alchemy.run/rivet";
 *
 * // Inside a RivetKit actor's createVars, or an Effect Durable Object that
 * // keeps the handle in memory for the activation:
 * const vm = await AgentOs.create();
 * await vm.process.exec("echo hello");
 * await vm.dispose();
 * ```
 */
export const client: Effect.Effect<AgentOsClient, never, Services | RuntimeContext> = Effect.gen(
  function* () {
    const services = yield* Services;
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    if (ctx === undefined) {
      return yield* Effect.die(
        new AgentOsCalledOutsideRuntime({
          message:
            "Rivet.AgentOs.client was called outside a runtime. Provide a services pool Layer to the runtime that calls it.",
        }),
      );
    }
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(
          sanitizeKey(`RIVET_SERVICES_${key}`),
          Output.isOutput(value) ? value : Output.literal(value),
        )
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", services.token);
    const endpoint = (yield* bind<string>("ENDPOINT", services.endpoint)) ?? "";
    const namespace = (yield* bind<string>("NAMESPACE", services.namespace)) ?? "";
    return createAgentOsClient({
      endpoint,
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
      namespace,
      poolName: SERVICES_POOL,
    });
  },
);
