import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  SecretManager as SecretManagerService,
  SecretManagerError,
  type SecretManagerLayer,
  type SecretManagerResolveOptions,
} from "../SecretManager.ts";

const managerName = "Doppler";
const downloadEndpoint =
  "https://api.doppler.com/v3/configs/config/secrets/download";

export interface SelectorContext {
  /** Name of the Alchemy stack being resolved. */
  readonly stack: string;
  /** Concrete Alchemy stage, when available. */
  readonly stage?: string;
}

/** A Doppler secret set selected for an Alchemy stack instance. */
export interface SecretSet {
  /** Doppler project name. Omit for a config-scoped service token. */
  readonly project?: string;
  /** Doppler config name. Omit for a config-scoped service token. */
  readonly config?: string;
}

/** Map an Alchemy stack and stage to a Doppler secret set. */
export type SecretsSelector = (context: SelectorContext) => SecretSet;

type Fetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

const failure = (message: string, cause?: unknown) =>
  new SecretManagerError({
    manager: managerName,
    message,
    cause,
  });

const isSecretRecord = (value: unknown): value is Record<string, string> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

const isSecretSet = (value: unknown): value is SecretSet =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (!("project" in value) ||
    value.project === undefined ||
    typeof value.project === "string") &&
  (!("config" in value) ||
    value.config === undefined ||
    typeof value.config === "string");

const makeResolve = (selector: SecretsSelector | undefined, fetch: Fetch) =>
  Effect.fn("Doppler.secrets.resolve")(function* ({
    stack,
    stage,
  }: SecretManagerResolveOptions) {
    const context = { stack, stage } satisfies SelectorContext;
    const selection = yield* Effect.try({
      try: () => (selector === undefined ? {} : selector(context)),
      catch: (cause) =>
        failure(
          `Doppler could not select a project or config for stack '${stack}'.`,
          cause,
        ),
    });
    if (!isSecretSet(selection)) {
      return yield* Effect.fail(
        failure(`Doppler selected an invalid secret set for stack '${stack}'.`),
      );
    }

    const token = yield* Config.redacted("DOPPLER_TOKEN").pipe(
      Effect.mapError((cause) =>
        failure(
          "Doppler is configured for this stack but DOPPLER_TOKEN is not set.",
          cause,
        ),
      ),
    );
    const tokenValue = Redacted.value(token);
    if (tokenValue.length === 0) {
      return yield* Effect.fail(
        failure(
          "Doppler is configured for this stack but DOPPLER_TOKEN is empty.",
        ),
      );
    }

    const url = new URL(downloadEndpoint);
    url.searchParams.set("format", "json");
    if (selection.project !== undefined) {
      url.searchParams.set("project", selection.project);
    }
    if (selection.config !== undefined) {
      url.searchParams.set("config", selection.config);
    }

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${tokenValue}`,
          },
          redirect: "error",
          signal,
        }),
      catch: (cause) =>
        failure(
          `Doppler could not download secrets for stack '${stack}'.`,
          cause,
        ),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        failure(
          `Doppler could not download secrets for stack '${stack}' (HTTP ${response.status}).`,
          new Error(
            `Doppler secrets download failed with HTTP ${response.status} ${response.statusText}.`,
          ),
        ),
      );
    }

    const secrets = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        failure(`Doppler returned invalid JSON for stack '${stack}'.`, cause),
    });
    if (!isSecretRecord(secrets)) {
      return yield* Effect.fail(
        failure(
          `Doppler returned an invalid secrets payload for stack '${stack}'.`,
        ),
      );
    }

    return ConfigProvider.fromUnknown(secrets);
  });

/** @internal */
export const makeSecretManager = (
  selector: SecretsSelector | undefined = undefined,
  fetch: Fetch = globalThis.fetch,
): SecretManagerLayer =>
  Layer.succeed(SecretManagerService, {
    name: managerName,
    resolve: makeResolve(selector, fetch),
  });

/**
 * Load an Alchemy stack's configuration from Doppler.
 *
 * The adapter reads `DOPPLER_TOKEN` from Alchemy's default configuration,
 * downloads the selected config as JSON, and exposes those values through
 * Effect `Config`. Alchemy composes the downloaded values over its default
 * provider. A config-scoped service token needs no project or config options.
 *
 * ### Configure a Stack
 * **Example:** Use a config-scoped Doppler service token
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Doppler from "alchemy/Doppler";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "app",
 *   {
 *     providers: Cloudflare.providers(),
 *     state: Cloudflare.state(),
 *     secrets: Doppler.secrets(),
 *   },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *     return { configured: apiKey !== undefined };
 *   }),
 * );
 * ```
 *
 * **Example:** Map Alchemy stacks and stages to Doppler
 * ```typescript
 * secrets: Doppler.secrets(({ stack, stage }) => ({
 *   project: stack,
 *   config: stage ?? "dev",
 * }));
 * ```
 *
 * @layer
 * @provides SecretManager
 * @product Doppler
 */
export const secrets = (selector?: SecretsSelector): SecretManagerLayer =>
  makeSecretManager(selector);
