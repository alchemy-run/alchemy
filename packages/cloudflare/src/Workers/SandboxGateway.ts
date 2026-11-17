import * as Gateway from "alchemy/Gateway";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { packEnvValueKeepRedacted } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { Worker } from "./Worker.ts";

const entry = new URL(
  import.meta.url.endsWith(".ts") ? "./SandboxGatewayEntry.ts" : "./SandboxGatewayEntry.js",
  import.meta.url,
).pathname;

/**
 * Runs the sandbox's gateway as a Cloudflare Worker. Provide it to the
 * sandbox's binding Layers: it deploys one Worker for that sandbox, which
 * runs the same program's Construction to build the bindings, with their
 * credentials in its own environment. The sandbox gets the Worker's URL and
 * a token, and its bindings call the ones the Worker holds.
 *
 * A Worker caps a request body (100 MB on most plans) and has no CONNECT or
 * SOCKS, so it suits API calls and small bodies.
 *
 * @layer
 * @product Worker
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
        const worker = (yield* Namespace.push(
          sandbox.LogicalId,
          // Bindings name what they create after their host, so the id is
          // unique to this sandbox.
          Worker(`${sandbox.LogicalId}Gateway`, {
            main: entry,
            env: { [Gateway.TOKEN_KEY]: secret.text },
            build: { input: { plugins: [Gateway.programPlugin(sandbox)] } },
          }),
        )) as Worker;
        return {
          self: worker,
          url: worker.url as unknown as Output.Output<string, never>,
          token: secret.text as unknown as Output.Output<Redacted.Redacted<string>, never>,
          set: (key, output) =>
            worker.bind(`Gateway(${key})`, {
              env: { [key]: output.pipe(Output.map(packEnvValueKeepRedacted)) },
            }),
        } satisfies Gateway.Deployed;
      }),
    ),
  ),
);
