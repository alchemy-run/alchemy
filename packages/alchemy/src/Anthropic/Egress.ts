import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { Egress as ContainerEgress } from "../Cloudflare/Containers/Egress.ts";
import {
  type CredentialInput,
  egressSecret,
  type EgressHandler,
  type EgressSecret,
} from "../Egress/Handler.ts";
import {
  checkSubject,
  type ConfiguredEgress,
  ConfiguredEgressTypeId,
  type EgressKind,
  EgressKindTypeId,
  EgressNotServed,
  type EgressRequest,
  resolveCredential,
} from "../Egress/Kind.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

export interface EgressOptions {
  /** The Anthropic API key, added to each request. Never enters the container. */
  readonly apiKey: EgressSecret;
}

/** Configures an Anthropic egress in a gateway's constructor. */
export interface GatewayEgressOptions {
  /**
   * The Anthropic API key: a secret bound into the gateway's host, or a
   * function of the grant's subject (looked up per request, cached per
   * subject briefly). Never enters the sandbox.
   */
  readonly apiKey:
    | EgressSecret
    | ((
        input: CredentialInput,
      ) => Effect.Effect<string | Redacted.Redacted<string>, unknown, RuntimeContext>);
}

/** What the container sees instead of the key. */
const PLACEHOLDER = "alchemy-egress";

const HOST = "api.anthropic.com";

const SANDBOX_ENV = {
  ANTHROPIC_API_KEY: PLACEHOLDER,
  // Telemetry and update checks have no egress: skip them.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** Replace whatever credential the sandbox sent with the real key. */
const withKey =
  (key: Effect.Effect<Redacted.Redacted<string>>): EgressHandler =>
  (request) =>
    Effect.map(key, (value) =>
      request.pipe(
        HttpClientRequest.removeHeader("authorization"),
        HttpClientRequest.setHeader("x-api-key", Redacted.value(value)),
      ),
    );

const containerEgress = (container: unknown, options: EgressOptions) =>
  Effect.gen(function* () {
    const apiKey = yield* egressSecret(options.apiKey, "ALCHEMY_ANTHROPIC_EGRESS_KEY");
    return yield* ContainerEgress(container, HOST, withKey(apiKey), {
      key: "anthropic",
      env: SANDBOX_ENV,
    });
  });

const gatewayEgress = (options: GatewayEgressOptions) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(
      options.apiKey,
      "ALCHEMY_ANTHROPIC_EGRESS_KEY",
      (secret): string | Redacted.Redacted<string> => secret,
    );
    const allows = (request: EgressRequest) =>
      request.scope !== undefined
        ? Effect.fail(new EgressNotServed({ message: "an Anthropic egress can't be narrowed" }))
        : checkSubject(credential.perSubject, request);
    return {
      [ConfiguredEgressTypeId]: "Anthropic",
      perSubject: credential.perSubject,
      allows,
      routes: () => Effect.succeed([{ host: HOST }]),
      handler: (request) =>
        Effect.map(credential.get(request.subject), (raw) =>
          withKey(Effect.succeed(Redacted.isRedacted(raw) ? raw : Redacted.make(raw))),
        ),
      env: SANDBOX_ENV,
      tools: [],
    } satisfies ConfiguredEgress<"Anthropic">;
  });

/** The `Anthropic.Egress` kind and its constructors. */
export interface EgressKindConstructor extends EgressKind<"Anthropic"> {
  /** Configure an Anthropic egress in a gateway's constructor (`Egress.Gateway.serve`). */
  (options: GatewayEgressOptions): Effect.Effect<ConfiguredEgress<"Anthropic">>;
  /** Anthropic API access for a container, handled in its owning Durable Object. */
  (container: unknown, options: EgressOptions): Effect.Effect<ContainerEgress>;
}

/**
 * Anthropic API access without the key ever entering the sandbox: requests
 * to `api.anthropic.com` get the real `x-api-key` in the egress gateway (or
 * the Durable Object that owns a Cloudflare container). The sandbox's
 * programs see a placeholder `ANTHROPIC_API_KEY`, so harnesses such as
 * Claude Code run unchanged.
 *
 * ### Serving the model from a gateway
 * **Example:** The key stays in the gateway's Worker
 * ```typescript
 * export class ModelGateway extends Egress.Gateway<ModelGateway>()("ModelGateway", {
 *   model: Anthropic.Egress,
 * }) {}
 *
 * export default Cloudflare.Worker(
 *   "ModelGatewayWorker",
 *   { main: import.meta.url },
 *   ModelGateway.serve(
 *     Effect.gen(function* () {
 *       return {
 *         model: yield* Anthropic.Egress({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") }),
 *       };
 *     }),
 *   ),
 * );
 * ```
 *
 * ### Giving a container model access
 * **Example:** Claude Code in a container, with the key kept in the Worker
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const model = yield* Anthropic.Egress(Sandbox, {
 *       apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
 *     });
 *     const harness = yield* Cloudflare.Containers.Harness(Sandbox);
 *     return Effect.gen(function* () {
 *       return {
 *         open: () =>
 *           harness.start({ size: "large", egress: [model] }).pipe(
 *             Effect.flatMap((claude) => claude.start({})),
 *             Effect.map((session) => session.id),
 *           ),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Egress
 * @category Anthropic
 */
export const Egress: EgressKindConstructor = Object.assign(
  (...args: [GatewayEgressOptions] | [unknown, EgressOptions]) =>
    args.length >= 2
      ? containerEgress(args[0], (args as [unknown, EgressOptions])[1])
      : gatewayEgress(args[0] as GatewayEgressOptions),
  { [EgressKindTypeId]: "Anthropic" as const },
) as EgressKindConstructor;
