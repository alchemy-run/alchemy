import {
  createOpenCode,
  type OpenCodeAuthOptions,
} from "@ai-sdk/harness-opencode";
import {
  type LocalSandboxServices,
  makeCodingAgentRuntime,
} from "@alchemy.run/harness-ai-sdk";
import type { CodingAgentRuntime } from "alchemy/AI";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * A non-secret configuration value: provided directly as a string or sourced
 * from `effect/Config` (`Config.string("…")`). Resolved during the layer's init
 * — which, because the layer is built in the container's Init phase, binds
 * `Config` values onto the container at deploy time and reads them back at
 * runtime.
 */
export type Configurable = string | Config.Config<string>;

/**
 * A secret configuration value. Credentials must never be passed as a bare
 * string — supply a `Redacted` (`Redacted.make(...)`) or, preferably, a
 * `Config` of one (`Config.redacted("ANTHROPIC_API_KEY")`) so the value is
 * bound onto the container as a `secret_text` and never leaks into logs.
 */
export type Secret =
  | Redacted.Redacted<string>
  | Config.Config<Redacted.Redacted<string>>;

/** Provider credentials, mirroring `@ai-sdk/harness-opencode`'s `auth` 1:1.
 * Credential fields are {@link Secret}s; non-secret fields are
 * {@link Configurable}s. */
export interface OpenCodeAuth {
  readonly gateway?: {
    readonly apiKey?: Secret;
    readonly baseUrl?: Configurable;
  };
  readonly anthropic?: {
    readonly apiKey?: Secret;
    readonly authToken?: Secret;
    readonly baseUrl?: Configurable;
  };
  readonly openai?: {
    readonly apiKey?: Secret;
    readonly baseUrl?: Configurable;
    readonly organization?: Configurable;
    readonly project?: Configurable;
  };
  readonly openaiCompatible?: {
    readonly apiKey?: Secret;
    readonly baseUrl?: Configurable;
    readonly name?: Configurable;
    readonly queryParams?: Record<string, string>;
  };
}

/** Options for {@link OpenCodeAgent} — OpenCode's settings, with credentials as
 * {@link Configurable}s. */
export interface OpenCodeAgentOptions extends OpenCodeAuth {
  /** Absolute path to the workspace (repo checkout) the agent operates on. */
  readonly workspace: string;
  /**
   * Default provider/model identifier, e.g. `"anthropic/claude-sonnet-4-5"`.
   * Overridable per turn via the `CodingAgentMessage.model` of a `send`.
   */
  readonly model: string;
  /**
   * Stable session id used for the agent's continuing conversation. Generated
   * once if omitted.
   */
  readonly session?: string;
  /**
   * OpenCode reasoning/thinking variant for reasoning-capable models
   * (`"low"`, `"medium"`, `"high"`, …).
   */
  readonly reasoningVariant?: string;
  /** Instructions prepended once to the agent's first message. */
  readonly instructions?: string;
  /**
   * Loopback TCP port the OpenCode bridge server binds to inside the sandbox.
   * The harness requires one (it has no default). **Leave unset.** Every turn
   * boots its own bridge, and a finished/interrupted turn's bridge keeps running
   * (it's a shell grandchild we can't reliably kill), so reusing one fixed port
   * makes the next turn's bridge collide and hang. When unset, each turn gets a
   * unique port — the only way sequential turns and post-interrupt recovery work
   * on a long-lived agent. Pin it only for single-turn use.
   */
  readonly port?: number;
}

/**
 * A {@link CodingAgentRuntime} `Layer` backed by the OpenCode runtime, driven
 * through the Vercel AI SDK harness (`@ai-sdk/harness-opencode`) and run inside
 * the host Container via {@link makeCodingAgentRuntime}. Provide it where
 * {@link LocalSandboxServices} are available (the Bun platform context inside the
 * container).
 *
 * Credentials mirror OpenCode's `auth` 1:1 but accept {@link Configurable}
 * values, resolved (and, for `Config`, bound onto the container) in this layer's
 * init.
 *
 * @example
 * ```ts
 * OpenCodeAgent({
 *   workspace: "/workspace",
 *   model: "anthropic/claude-sonnet-4-5",
 *   anthropic: { apiKey: Config.redacted("ANTHROPIC_API_KEY") },
 * });
 * ```
 */
export const OpenCodeAgent = (
  options: OpenCodeAgentOptions,
): Layer.Layer<CodingAgentRuntime, never, LocalSandboxServices> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const auth = {
        gateway: yield* resolveProvider(options.gateway),
        anthropic: yield* resolveProvider(options.anthropic),
        openai: yield* resolveProvider(options.openai),
        openaiCompatible: yield* resolveProvider(options.openaiCompatible),
      } satisfies Record<string, unknown> as OpenCodeAuthOptions;

      return makeCodingAgentRuntime(
        (input) =>
          createOpenCode({
            ...splitModel(input.model),
            auth,
            reasoningVariant: options.reasoningVariant,
            port: options.port ?? allocatePort(),
          }),
        {
          workspace: options.workspace,
          model: options.model,
          session: options.session,
          instructions: options.instructions,
        },
      );
    }).pipe(Effect.orDie),
  );

// Hand out a distinct loopback port per turn, from a per-process random base so
// concurrent processes / leaked bridges from earlier runs are unlikely to clash.
let nextPort = 30_000 + Math.floor(Math.random() * 20_000);
const allocatePort = () => nextPort++;

/** Split a `provider/model` identifier into OpenCode's `{ provider, model }`. */
const splitModel = (model: string): { provider?: string; model: string } => {
  const i = model.indexOf("/");
  return i === -1
    ? { model }
    : { provider: model.slice(0, i), model: model.slice(i + 1) };
};

/** Resolve every credential field on one provider record. */
const resolveProvider = <P extends Record<string, unknown>>(
  provider: P | undefined,
): Effect.Effect<Record<string, unknown> | undefined, Config.ConfigError> =>
  provider === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(provider)) {
          // Strings, `Redacted`, and `Config` are resolved; `queryParams` (a
          // plain Record) passes through untouched.
          out[key] =
            value === undefined ||
            typeof value === "string" ||
            Redacted.isRedacted(value) ||
            Config.isConfig(value)
              ? yield* resolveValue(value as Secret | Configurable | undefined)
              : value;
        }
        return out;
      });

/** Resolve a single {@link Secret} or {@link Configurable} to its raw string
 * value (unwrapping `Redacted` / `Config` results), or `undefined` when absent. */
const resolveValue = (
  value: Secret | Configurable | undefined,
): Effect.Effect<string | undefined, Config.ConfigError> =>
  Effect.gen(function* () {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    if (Redacted.isRedacted(value)) return Redacted.value(value);
    const resolved = yield* value as Config.Config<
      string | Redacted.Redacted<string>
    >;
    return Redacted.isRedacted(resolved) ? Redacted.value(resolved) : resolved;
  });
