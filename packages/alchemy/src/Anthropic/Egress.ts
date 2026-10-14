import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import {
  Egress as ContainerEgress,
  egressSecret,
  type EgressSecret,
} from "../Cloudflare/Containers/Egress.ts";

export interface EgressOptions {
  /** The Anthropic API key, added to each request. Never enters the container. */
  readonly apiKey: EgressSecret;
}

/** What the container sees instead of the key. */
const PLACEHOLDER = "alchemy-egress";

/**
 * Anthropic API access for a container, without its key ever entering the
 * container: requests to `api.anthropic.com` get the real `x-api-key` in the
 * Durable Object that owns the container. The container's programs see a
 * placeholder `ANTHROPIC_API_KEY`, so harnesses such as Claude Code run
 * unchanged.
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
export const Egress = (container: unknown, options: EgressOptions) =>
  Effect.gen(function* () {
    const apiKey = yield* egressSecret(options.apiKey, "ALCHEMY_ANTHROPIC_EGRESS_KEY");
    return yield* ContainerEgress(
      container,
      "api.anthropic.com",
      (request) =>
        Effect.map(apiKey, (key) =>
          request.pipe(
            HttpClientRequest.removeHeader("authorization"),
            HttpClientRequest.setHeader("x-api-key", Redacted.value(key)),
          ),
        ),
      {
        key: "anthropic",
        env: {
          ANTHROPIC_API_KEY: PLACEHOLDER,
          // Telemetry and update checks have no egress: skip them.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    );
  });
