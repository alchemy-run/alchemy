import * as apiKeys from "@distilled.cloud/e2b/api_keys";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { E2BUnexpectedResponse } from "./Errors.ts";
import { e2bName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ApiKeyProps {
  /**
   * Key name. If omitted, a unique name is generated from the stack, stage
   * and logical ID. Renamed in place.
   */
  name?: string;
}

export interface ApiKeyAttributes {
  /** E2B's API key id. */
  apiKeyId: string;
  name: string;
  /** The key, sent as `X-API-Key`. Only shown once by E2B; Alchemy keeps it in state. */
  key: Redacted.Redacted<string>;
  /** The key's masked form, as the dashboard shows it. */
  mask: string;
}

export interface ApiKey extends Resource<
  "E2B.ApiKey",
  ApiKeyProps,
  ApiKeyAttributes,
  never,
  Providers
> {}

/**
 * An E2B team API key.
 *
 * E2B keys are not scoped: every key reaches every sandbox, template, volume
 * and secret in the team. Mint a separate key per app or CI system so you
 * can revoke one without the others.
 *
 * E2B mints API keys only with a personal access token: set `accessToken`
 * in the E2B profile, or `E2B_ACCESS_TOKEN` in CI. The team defaults to the
 * token's default team. E2B shows the key once, at creation; Alchemy keeps it
 * in state as a `Redacted` value. A key whose value was lost is replaced.
 *
 * ### Creating an API key
 * **Example:** A key for CI
 * ```typescript
 * export const Ci = E2B.ApiKey("Ci", {});
 * ```
 *
 * **Example:** Pass the key to a Worker as a secret
 * ```typescript
 * const ci = yield* Ci;
 * yield* GitHub.Secret("E2B_API_KEY", { repository: "my-org/app", value: ci.key });
 * ```
 *
 * @resource
 * @product API key
 */
export const ApiKey = Resource<ApiKey>("E2B.ApiKey");

const maskOf = (mask: apiKeys.IdentifierMaskingDetails) =>
  `${mask.prefix}${mask.maskedValuePrefix}…${mask.maskedValueSuffix}`;

const findById = (apiKeyId: string) =>
  apiKeys.listApiKeys({}).pipe(Effect.map((all) => all.find((key) => key.id === apiKeyId)));

const redact = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      return {
        stables: ["apiKeyId", "key"],
        read: Effect.fn(function* ({ olds, output }) {
          // E2B never returns a key's value after creation: without the
          // stored value there is nothing to adopt, so a key is only ours
          // through state.
          if (output === undefined) return undefined;
          const key = yield* findById(output.apiKeyId);
          if (key === undefined) return undefined;
          const attrs = { ...output, name: key.name, mask: maskOf(key.mask) };
          return olds !== undefined || isGeneratedName(key.name) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = news.name ?? output?.name ?? (yield* e2bName(id, undefined));

          // Observe — E2B shows a key's value only at creation, so the only
          // usable key is one whose value is in state.
          const held =
            output === undefined
              ? undefined
              : { stored: output, observed: yield* findById(output.apiKeyId) };

          // Ensure
          if (held?.observed === undefined) {
            yield* session.note(`Creating API key ${name}...`);
            const created = yield* apiKeys.createApiKey({ name });
            return {
              apiKeyId: created.id,
              name: created.name,
              key: redact(created.key),
              mask: maskOf(created.mask),
            };
          }

          const { stored, observed } = held;

          // Sync — the name is the only mutable aspect.
          if (observed.name !== name) {
            yield* apiKeys.updateApiKey({ apiKeyID: observed.id, name });
            const renamed = yield* findById(observed.id);
            if (renamed === undefined) {
              return yield* new E2BUnexpectedResponse({
                message: `E2B API key ${name} vanished after rename`,
              });
            }
            return { ...stored, name: renamed.name, mask: maskOf(renamed.mask) };
          }
          return { ...stored, name: observed.name, mask: maskOf(observed.mask) };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* apiKeys
            .deleteApiKey({ apiKeyID: output.apiKeyId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        // For nuke. E2B never returns a key's value, so listed keys carry an
        // empty one; delete needs only the id.
        list: Effect.fn(function* () {
          const all = yield* apiKeys.listApiKeys({});
          return all
            .filter((key) => isGeneratedName(key.name))
            .map((key) => ({
              apiKeyId: key.id,
              name: key.name,
              key: Redacted.make(""),
              mask: maskOf(key.mask),
            }));
        }),
      };
    }),
  );
