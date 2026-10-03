import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { CHILD_BUDGET, createChildName, sameArm } from "./Common.ts";

export interface RaiExternalSafetyProviderProps {
  /**
   * Provider resource name, unique in the subscription. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the provider.
   */
  name?: string;
  /** Display name of the external safety provider. */
  providerName: string;
  /** Provider ID assigned by the external service. */
  providerId?: string;
  /** Call mode, e.g. `sync` or `async`. */
  mode: string;
  /** Webhook URL the guardrails call. */
  url: string;
  /** Key Vault URI that holds the provider's secret. */
  keyVaultUri?: string;
  /** Name of the secret in `keyVaultUri`. */
  secretName?: string;
  /** Client ID of the managed identity that reads the secret. */
  managedIdentity?: string;
}

export interface RaiExternalSafetyProvider extends Resource<
  "Azure.CognitiveServices.RaiExternalSafetyProvider",
  RaiExternalSafetyProviderProps,
  {
    /** Resource name of the provider; reference it from `RaiPolicy.safetyProviders`. */
    safetyProviderName: string;
    /** ARM resource ID of the provider. */
    safetyProviderId: string;
    /** Display name. */
    providerName: string | undefined;
    /** Webhook URL. */
    url: string | undefined;
    /** Call mode. */
    mode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A subscription-wide registration of a third-party content-safety
 * service (`Microsoft.CognitiveServices/raiExternalSafetyProviders`,
 * preview) that RAI policies can call through `safetyProviders`.
 *
 * The API accepts no tags, so Alchemy cannot mark the provider as owned:
 * reading an existing provider without state always reports it as unowned.
 *
 * ### Registering a Provider
 * **Example:** Webhook with a Key Vault secret
 * ```typescript
 * const provider = yield* Azure.CognitiveServices.RaiExternalSafetyProvider("acme", {
 *   providerName: "acme-safety",
 *   mode: "sync",
 *   url: "https://safety.acme.example/check",
 *   keyVaultUri: vault.vaultUri,
 *   secretName: "acme-api-key",
 *   managedIdentity: identity.clientId,
 * });
 * ```
 *
 * @resource
 */
export const RaiExternalSafetyProvider = Resource<RaiExternalSafetyProvider>(
  "Azure.CognitiveServices.RaiExternalSafetyProvider",
);

const getProvider = (subscriptionId: string, safetyProviderName: string) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetRaiExternalSafetyProvider({
      subscriptionId,
      safetyProviderName,
    }),
  );

const toAttrs = (
  name: string,
  provider: cognitiveservices.GetRaiExternalSafetyProviderResponse,
): RaiExternalSafetyProvider["Attributes"] => ({
  safetyProviderName: name,
  safetyProviderId: provider.id ?? "",
  providerName: provider.properties?.providerName,
  url: provider.properties?.url,
  mode: provider.properties?.mode,
});

const FIELDS = [
  "providerName",
  "providerId",
  "mode",
  "url",
  "keyVaultUri",
  "secretName",
  "managedIdentity",
] as const;

export const RaiExternalSafetyProviderProvider = () =>
  Provider.succeed(RaiExternalSafetyProvider, {
    stables: ["safetyProviderName", "safetyProviderId"],

    // Providers carry no ownership tags, so nuke cannot attribute them.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        !sameArm(news.name, output.safetyProviderName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // No tags or markers: an untracked provider is never claimed silently.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name =
        output?.safetyProviderName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getProvider(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, observed);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const name =
        news.name ?? output?.safetyProviderName ?? (yield* createChildName(id));
      const properties = {
        providerName: news.providerName,
        providerId: news.providerId,
        mode: news.mode,
        url: news.url,
        keyVaultUri: news.keyVaultUri,
        secretName: news.secretName,
        managedIdentity: news.managedIdentity,
      };
      const get = getProvider(subscriptionId, name);

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      if (
        observed === undefined ||
        FIELDS.some(
          (field) =>
            properties[field] !== undefined &&
            observed.properties?.[field] !== properties[field],
        )
      ) {
        yield* cognitiveservices.RaiExternalSafetyProviderCreateOrUpdate({
          subscriptionId,
          safetyProviderName: name,
          properties,
        });
      }
      const fresh = yield* waitForProvisioned(
        `rai external safety provider ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return toAttrs(name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices.DeleteRaiExternalSafetyProvider({
          subscriptionId,
          safetyProviderName: output.safetyProviderName,
        }),
      );
      yield* waitUntilGone(
        `rai external safety provider ${output.safetyProviderName}`,
        getProvider(subscriptionId, output.safetyProviderName),
        CHILD_BUDGET,
      );
    }),
  });
