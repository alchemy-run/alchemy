/**
 * How Boat bindings reach Boat from any host.
 *
 * Boat has scoped API keys and no identity federation, so every binding
 * mints its own key at deploy, a `Boat.ApiKey` in the host's namespace,
 * with only the actions it needs and, for a declared sandbox, only that
 * sandbox. The key is deleted with the host. The deployer's credentials
 * never reach a host. The binding captures the key as a named runtime
 * Output; inside the deployed host it is read back from the host's env,
 * still `Redacted`. Every runtime call provides `Credentials` from it, so
 * nothing reads `process.env`. The deployer's org and API URL are bound
 * alongside it (`BOAT_ORG`, `BOAT_API_BASE_URL`), so the host's calls bill
 * the same wallet the deploy did.
 *
 * Bindings that create sandboxes at run time label them with the host's
 * `alchemy.stack` / `alchemy.stage` / `alchemy.id`, computed at deploy and
 * bound into the host (`bindOwnerLabels`). Destroying the stack does not
 * delete them.
 */
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/boat-dev/Credentials";
import { orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Binding from "alchemy/Binding";
import type { PropsInput } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ApiKey, type ApiKeyProps } from "./ApiKey.ts";
import { ALCHEMY_LABEL_PREFIX } from "./internal/Ownership.ts";

/** A plain value as an Output with no requirements (`asOutput` leaves them `any`). */
const output = <A>(value: A) => Output.asOutput(value) as Output.Output<A, never>;

/** The `alchemy.*` labels on sandboxes a host creates at run time. */
export type OwnerLabels = Readonly<Record<string, string>>;

export interface BoatAuth {
  /** Runs a distilled call with the binding's key and an HTTP client. */
  readonly authorize: <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

/**
 * Mints the binding's key (`<keyId>` in the host's namespace, with
 * `scope`) and binds it onto the host as `<envName>`, and returns a runtime
 * accessor for it. Without a host (a script) nothing is minted, and calls
 * use the ambient credentials.
 */
export const bindBoat = Effect.fn("Boat.bind")(function* (
  keyId: string,
  envName: string,
  scope: PropsInput<ApiKeyProps>,
) {
  // Yielding the resource class erases its `Providers` requirement; the
  // stack satisfies it at plan time.
  const makeKey = yield* ApiKey;
  let apiKey: Output.Output<Redacted.Redacted<string>, never> = output(Redacted.make(""));
  let deployer = { apiBaseUrl: DEFAULT_API_BASE_URL, org: "" };
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    if (host !== undefined) {
      const key = yield* Namespace.push(host.LogicalId, makeKey(keyId, scope));
      apiKey = key.key as Output.Output<Redacted.Redacted<string>, never>;
      const credentials = yield* Effect.serviceOption(Credentials);
      if (Option.isSome(credentials)) {
        const { apiBaseUrl, org } = yield* credentials.value.pipe(
          orDieCredentialsUnavailable("Boat"),
        );
        deployer = { apiBaseUrl, org: org ?? "" };
      }
    }
  }
  const key = yield* Output.named(apiKey, envName).asEffect();
  const apiBaseUrl = yield* Output.named(
    output(deployer.apiBaseUrl),
    "BOAT_API_BASE_URL",
  ).asEffect();
  const org = yield* Output.named(output(deployer.org), "BOAT_ORG").asEffect();
  const services = Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.all([key, apiBaseUrl, org]).pipe(
        Effect.map(([apiKey, apiBaseUrl, org]) => ({
          apiKey,
          apiBaseUrl: apiBaseUrl || DEFAULT_API_BASE_URL,
          ...(org ? { org } : {}),
        })),
      ),
    ),
    FetchHttpClient.layer,
  );
  return {
    authorize: (effect) => effect.pipe(Effect.provide(services)),
  } satisfies BoatAuth;
});

const parseOwnerLabels = (json: string): OwnerLabels => {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
};

/**
 * Binds the host's `alchemy.stack` / `alchemy.stage` / `alchemy.id` into
 * it, and returns them at run time for `create` to label what it makes.
 * Without a host (a script) there are none.
 */
export const bindOwnerLabels = Effect.gen(function* () {
  let labels = "{}";
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    // The values `createInternalTags(host.LogicalId)` gives, read without
    // adding `Stack` / `Stage` to the binding's requirements.
    const stack = yield* Effect.serviceOption(Stack);
    const stage = yield* Effect.serviceOption(Stage);
    if (host !== undefined && Option.isSome(stack) && Option.isSome(stage)) {
      labels = JSON.stringify({
        [`${ALCHEMY_LABEL_PREFIX}stack`]: stack.value.name,
        [`${ALCHEMY_LABEL_PREFIX}stage`]: stage.value,
        [`${ALCHEMY_LABEL_PREFIX}id`]: host.LogicalId,
      } satisfies OwnerLabels);
    }
  }
  const bound = yield* Output.named(output(labels), "BOAT_OWNER_LABELS").asEffect();
  return Effect.map(bound, parseOwnerLabels);
});
