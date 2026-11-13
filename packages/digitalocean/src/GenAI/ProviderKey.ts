import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type ProviderKeyProps = {
  /** The model provider the key belongs to. A change replaces the key. */
  provider: "openai" | "anthropic";
  /** The provider's API key. DigitalOcean checks it on create. Updates in place. */
  apiKey: string | Redacted.Redacted<string>;
  /**
   * Name. Updates in place.
   *
   * @default a generated physical name
   */
  name?: string;
};

export type ProviderKey = Resource<
  "DigitalOcean.GenAI.ProviderKey",
  ProviderKeyProps,
  {
    /** Key UUID. */
    providerKeyId: string;
    /** The model provider. */
    provider: "openai" | "anthropic";
    /** Name. */
    name: string;
  },
  never,
  Providers
>;

export type ProviderKeyAttributes = ProviderKey["Attributes"];

/**
 * Your own OpenAI or Anthropic API key, registered with the GenAI Platform so
 * agents can run on that provider's models, billed to your provider account.
 * DigitalOcean validates the key when it is added.
 *
 * ### Bringing Your Own Key
 * **Example:** An Anthropic key
 * ```typescript
 * const apiKey = yield* Config.Redacted("ANTHROPIC_API_KEY");
 * yield* DigitalOcean.GenAI.ProviderKey("anthropic", { provider: "anthropic", apiKey });
 * ```
 *
 * @see https://docs.digitalocean.com/products/genai-platform/how-to/use-model-provider-keys/
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const ProviderKey = Resource<ProviderKey>("DigitalOcean.GenAI.ProviderKey");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const secret = (value: string | Redacted.Redacted<string>) =>
  typeof value === "string" ? value : Redacted.value(value);

const observe = (provider: ProviderKeyProps["provider"], uuid: string) =>
  provider === "openai"
    ? noneIfNotFound(
        DO.getGenaiOpenaiApiKey({ api_key_uuid: uuid }).pipe(Effect.map((r) => r.api_key_info)),
      )
    : noneIfNotFound(
        DO.getGenaiAnthropicApiKey({ api_key_uuid: uuid }).pipe(Effect.map((r) => r.api_key_info)),
      );

export const ProviderKeyProvider = () =>
  Provider.succeed(ProviderKey, {
    stables: ["providerKeyId", "provider"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.provider, output.providerKeyId);
      return Option.isSome(observed) && !observed.value?.deleted_at ? output : undefined;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.provider !== olds.provider) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const apiKey = secret(news.apiKey);
      const observed =
        output === undefined ? Option.none() : yield* observe(news.provider, output.providerKeyId);
      if (Option.isNone(observed) || observed.value === undefined || observed.value.deleted_at) {
        const created =
          news.provider === "openai"
            ? yield* DO.createGenaiOpenaiApiKey({ name, api_key: apiKey })
            : yield* DO.createGenaiAnthropicApiKey({ name, api_key: apiKey });
        return { providerKeyId: created.api_key_info.uuid, provider: news.provider, name };
      }
      // The key itself is write-only; a change is seen against the props.
      const changed =
        observed.value.name !== name || olds === undefined || secret(olds.apiKey) !== apiKey;
      if (changed) {
        const update = { api_key_uuid: observed.value.uuid, name, api_key: apiKey };
        yield* news.provider === "openai"
          ? DO.updateGenaiOpenaiApiKey(update)
          : DO.updateGenaiAnthropicApiKey(update);
      }
      return { providerKeyId: observed.value.uuid, provider: news.provider, name };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        output.provider === "openai"
          ? DO.deleteGenaiOpenaiApiKey({ api_key_uuid: output.providerKeyId })
          : DO.deleteGenaiAnthropicApiKey({ api_key_uuid: output.providerKeyId }),
      );
    }),
  });
