import * as Gateway from "alchemy/Gateway";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { WebFunction } from "./WebFunction.ts";

const entry = new URL(
  import.meta.url.endsWith(".ts") ? "./SandboxGatewayEntry.ts" : "./SandboxGatewayEntry.js",
  import.meta.url,
).pathname;

/**
 * Runs the sandbox's gateway as a Lambda Web Function. Provide it to the
 * sandbox's binding Layers: it deploys one Web Function for that sandbox,
 * which runs the same program's Construction to build the bindings. AWS
 * bindings are granted on its execution role, so no AWS key exists; other
 * bindings' credentials are in its environment. The sandbox gets the Web
 * Function's URL and a token, and its bindings call the ones it holds.
 *
 * A Web Function streams requests and responses in both directions, so it
 * suits large bodies. Its environment is capped at 4 KB, which bounds how
 * many credentials one gateway can hold.
 *
 * @layer
 * @product WebFunction
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
        const fn = (yield* Namespace.push(
          sandbox.LogicalId,
          // Bindings name what they create after their host, so the id is
          // unique to this sandbox.
          WebFunction(`${sandbox.LogicalId}Gateway`, {
            main: entry,
            // The gateway checks the sandbox's token itself.
            authType: "ApplicationManaged",
            // Packed like every bound value, so the secret survives the
            // function's plain-string environment.
            env: { [Gateway.TOKEN_KEY]: secret.text.pipe(Output.map(packEnvValue)) },
            build: { plugins: [Gateway.programPlugin(sandbox)] },
          }),
        )) as WebFunction;
        return {
          self: fn,
          url: fn.url as unknown as Output.Output<string, never>,
          token: secret.text as unknown as Output.Output<Redacted.Redacted<string>, never>,
          set: (key, output) =>
            fn.bind(`Gateway(${key})`, {
              env: { [key]: output.pipe(Output.map(packEnvValue)) },
            }),
        } satisfies Gateway.Deployed;
      }),
    ),
  ),
);
