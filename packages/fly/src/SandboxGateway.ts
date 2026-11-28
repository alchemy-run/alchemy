import * as Gateway from "alchemy/Gateway";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { packEnvValueKeepRedacted } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { Service } from "./Service.ts";

const entry = new URL(
  import.meta.url.endsWith(".ts") ? "./SandboxGatewayEntry.ts" : "./SandboxGatewayEntry.js",
  import.meta.url,
).pathname;

/**
 * Runs the sandbox's gateway as a Fly Service. Provide it to the sandbox's
 * binding Layers: it deploys one Service (and its App) for that sandbox,
 * which runs the same program's Construction to build the bindings, with
 * their credentials as App secrets. The sandbox gets the Service's URL and
 * a token, and its bindings call the ones the Service holds.
 *
 * A Fly Service is a process on a Machine: it streams requests and
 * responses of any size and keeps connections open, and it is billed while
 * it runs.
 *
 * @layer
 * @product Service
 * @provides Alchemy.Gateway
 */
export const SandboxGateway = Layer.effect(
  Gateway.Gateway,
  // Yielding the resource class erases its `Providers` requirement; the
  // stack satisfies it at plan time.
  Effect.flatMap(Random, (makeRandom) =>
    Gateway.make(
      Effect.gen(function* () {
        const sandbox = yield* Self;
        const secret = yield* Namespace.push(sandbox.LogicalId, makeRandom("GatewayToken"));
        const service = (yield* Namespace.push(
          sandbox.LogicalId,
          // The Service's own program is the gateway's entry, so there is
          // nothing to construct here.
          Service(
            Gateway.gatewayId(sandbox.LogicalId),
            {
              main: entry,
              env: { [Gateway.TOKEN_KEY]: secret.text },
              build: { input: { plugins: [Gateway.programPlugin(sandbox)] } },
            },
            Effect.succeed({}),
          ),
        )) as Service;
        return {
          self: service,
          url: service.url as unknown as Output.Output<string, never>,
          token: secret.text as unknown as Output.Output<Redacted.Redacted<string>, never>,
          set: (key, output) =>
            service.bind(`Gateway(${key})`, {
              env: { [key]: output.pipe(Output.map(packEnvValueKeepRedacted)) },
            }),
        } satisfies Gateway.Deployed;
      }),
      { type: Service.Type },
    ),
  ),
);
