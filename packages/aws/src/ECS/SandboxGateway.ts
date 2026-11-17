import * as Gateway from "alchemy/Gateway";
import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { Service, type BundledServiceProps } from "./Service.ts";

const entry = new URL(
  import.meta.url.endsWith(".ts") ? "./SandboxGatewayEntry.ts" : "./SandboxGatewayEntry.js",
  import.meta.url,
).pathname;

/** Where and how the gateway's ECS Service runs. Its program is the gateway. */
export type SandboxGatewayProps = InputProps<
  Omit<BundledServiceProps, "main" | "handler" | "build">
>;

/**
 * Runs the sandbox's gateway as an ECS Service on your cluster. Provide it
 * to the sandbox's binding Layers: it deploys one Service for that sandbox,
 * which runs the same program's Construction to build the bindings. AWS
 * bindings are granted on its task role, so no AWS key exists. The sandbox
 * gets the Service's URL and a token, and its bindings call the ones the
 * Service holds.
 *
 * An ECS Service is a process: it streams requests and responses of any
 * size, can sit inside your VPC, and is billed while it runs. Give its load
 * balancer a `domain`, so the sandbox's token travels over HTTPS.
 *
 * ### Provide the layer
 * **Example:** On a cluster, behind a domain
 * ```typescript
 * Effect.provide(
 *   AWS.S3.GetObjectHttp.pipe(
 *     Layer.provide(
 *       AWS.ECS.SandboxGateway({
 *         cluster: MyCluster,
 *         port: 3000,
 *         loadBalancer: { domain: "gateway.example.com" },
 *       }),
 *     ),
 *   ),
 * )
 * ```
 *
 * @layer
 * @product Service
 * @provides Alchemy.Gateway
 */
export const SandboxGateway = (
  props: SandboxGatewayProps | Effect.Effect<SandboxGatewayProps, never, any>,
) =>
  Layer.effect(
    Gateway.Gateway,
    // Yielding the resource class erases its `Providers` requirement; the
    // stack satisfies it at plan time.
    Effect.flatMap(Random, (makeRandom) =>
      Gateway.make(
        Effect.gen(function* () {
          const sandbox = yield* Self;
          const secret = yield* Namespace.push(sandbox.LogicalId, makeRandom("GatewayToken"));
          const resolved = Effect.isEffect(props) ? yield* props : props;
          const service = (yield* Namespace.push(
            sandbox.LogicalId,
            // The Service's own program is the gateway's entry, so there is
            // nothing to construct here.
            Service(
              Gateway.gatewayId(sandbox.LogicalId),
              {
                ...resolved,
                main: entry,
                env: {
                  ...resolved.env,
                  // Packed like every bound value, so the secret survives
                  // the container's plain-string environment.
                  [Gateway.TOKEN_KEY]: secret.text.pipe(Output.map(packEnvValue)),
                },
                build: { input: { plugins: [Gateway.programPlugin(sandbox)] } },
              } as InputProps<BundledServiceProps>,
              Effect.succeed({}),
            ),
          )) as Service;
          return {
            self: service,
            url: service.url as unknown as Output.Output<string, never>,
            token: secret.text as unknown as Output.Output<Redacted.Redacted<string>, never>,
            set: (key, output) =>
              service.bind(`Gateway(${key})`, {
                env: { [key]: output.pipe(Output.map(packEnvValue)) },
              }),
          } satisfies Gateway.Deployed;
        }),
        { type: Service.Type },
      ),
    ),
  );
