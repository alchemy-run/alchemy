import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Secret, type StoreSecretProps } from "../SecretsStore/Secret.ts";
import {
  GatewayProvider,
  type GatewayProviderProps,
} from "./GatewayProvider.ts";

type GatewayProviderInputProps = {
  [K in keyof GatewayProviderProps]: Input<GatewayProviderProps[K]>;
};

export type ProviderKeyProps = Omit<
  GatewayProviderInputProps,
  "alias" | "secretId"
> & {
  /**
   * The Secrets Store attached to the AI Gateway via `storeId`.
   */
  store: Input<StoreSecretProps["store"]>;
  /**
   * The provider API key. Stored in Cloudflare Secrets Store and never bound
   * into the Worker runtime.
   */
  value: Input<StoreSecretProps["value"]>;
  /**
   * Alias distinguishing multiple keys for the same provider.
   * @default "default"
   */
  alias?: string;
  /**
   * Optional free-form description on the Secrets Store secret.
   */
  comment?: string;
};

export type ProviderKey = {
  readonly secret: Secret;
  readonly gatewayProvider: GatewayProvider;
};

/**
 * Declares a Cloudflare AI Gateway BYOK provider key.
 *
 * Cloudflare requires BYOK secrets to live in the gateway's attached Secrets
 * Store, be scoped to `ai_gateway`, and use the exact
 * `{gatewayId}_{providerSlug}_{alias}` name. This helper keeps that naming
 * contract with the {@link GatewayProvider} declaration so app stacks do not
 * have to wire the secret and provider config manually.
 *
 * @example Bring your own OpenAI key
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("Store");
 *
 * const gateway = yield* Cloudflare.AI.Gateway("Gateway", {
 *   id: "my-gateway",
 *   storeId: store.storeId,
 * });
 *
 * const { secret, gatewayProvider } = yield* Cloudflare.AI.ProviderKey("OpenAiKey", {
 *   store,
 *   gatewayId: gateway.gatewayId,
 *   providerSlug: "openai",
 *   value: yield* Config.redacted("OPENAI_API_KEY"),
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
 */
export const ProviderKey = (id: string, props: ProviderKeyProps) =>
  Effect.gen(function* () {
    const alias = props.alias ?? "default";
    const secret = yield* Secret("Secret", {
      store: props.store,
      name: Output.interpolate`${props.gatewayId}_${props.providerSlug}_${alias}`,
      value: props.value,
      scopes: ["ai_gateway"],
      comment: props.comment,
    });

    const gatewayProvider = yield* GatewayProvider("Provider", {
      gatewayId: props.gatewayId,
      providerSlug: props.providerSlug,
      alias,
      secretId: secret.secretId,
      defaultConfig: props.defaultConfig,
      rateLimit: props.rateLimit,
      rateLimitPeriod: props.rateLimitPeriod,
    });

    return {
      secret,
      gatewayProvider,
    } satisfies ProviderKey;
  }).pipe(Namespace.push(id));
