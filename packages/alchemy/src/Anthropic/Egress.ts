import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { type CredentialInput, type EgressHandler, type EgressSecret } from "../Egress/Handler.ts";
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

/** The `Anthropic.Egress` kind, as named in a gateway or sandbox declaration. */
export interface Egress extends EgressKind<"Anthropic"> {
  /** Configure an Anthropic egress in a gateway's constructor (`Egress.Gateway.serve`). */
  (options: GatewayEgressOptions): Effect.Effect<ConfiguredEgress<"Anthropic">>;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Anthropic API access without the key ever entering the sandbox: requests
 * to `api.anthropic.com` get the real `x-api-key` in an egress gateway. A
 * sandbox granted it sees a placeholder `ANTHROPIC_API_KEY`, so harnesses
 * such as Claude Code run unchanged.
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
 * ### Granting model access to a sandbox
 * **Example:** Claude Code in a sandbox, with the key kept in the gateway
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const gateway = yield* ModelGateway;
 *     const harness = yield* Cloudflare.Containers.Harness(Sandbox);
 *     return Effect.gen(function* () {
 *       return {
 *         open: () =>
 *           harness.start({ size: "large", egress: [gateway.model] }).pipe(
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
export const Egress: Egress = Object.assign(gatewayEgress, {
  [EgressKindTypeId]: "Anthropic" as const,
  env: SANDBOX_ENV,
});
