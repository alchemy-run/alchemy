import * as OpenRouter from "@distilled.cloud/openrouter";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** How often an {@link ApiKey}'s credit `limit` resets (midnight UTC; weeks run Monday–Sunday). */
export type ApiKeyLimitReset = "daily" | "weekly" | "monthly";

export interface ApiKeyProps {
  /**
   * Display name of the key. OpenRouter does not require names to be unique.
   * Changing it renames the key in place.
   * @default an instance-qualified physical name derived from the app, stage and logical ID
   */
  name?: string;
  /**
   * Spending limit for the key in USD of OpenRouter credits. Requests fail
   * with `InsufficientCredits` once the limit is reached. Omit for no
   * limit. Updated in place.
   */
  limit?: number;
  /**
   * How often the spending `limit` resets. Omit for a lifetime limit that
   * never resets. Updated in place.
   */
  limitReset?: ApiKeyLimitReset;
  /**
   * Whether bring-your-own-key (BYOK) usage counts toward `limit`.
   * @default false
   */
  includeByokInLimit?: boolean;
  /**
   * Disable the key without deleting it. Disabled keys are rejected with
   * `InvalidApiKey` until re-enabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * ISO 8601 UTC expiration timestamp with seconds precision
   * (`YYYY-MM-DDTHH:MM:SSZ`). Changing it replaces the key, which mints a
   * new secret.
   */
  expiresAt?: string;
  /**
   * Workspace to create the key in. Changing it replaces the key.
   * @default the account's default workspace
   */
  workspaceId?: string;
}

export interface ApiKeyAttributes {
  /** Stable identifier of the key (its hash). Never the secret itself. */
  hash: string;
  /** Observed display name. */
  name: string;
  /** Redacted label OpenRouter shows for the key (e.g. `sk-or-v1-abc...xyz`). */
  label: string;
  /**
   * The secret API key (`sk-or-v1-…`). OpenRouter reveals it exactly once,
   * in the create response, so it is captured into Alchemy state as a
   * `Redacted` value and preserved across updates. Treat state as
   * sensitive.
   */
  key: Redacted.Redacted<string>;
  /** Spending limit in USD, or `undefined` for none. */
  limit: number | undefined;
  /** Remaining spend in the current limit window, or `undefined` for none. */
  limitRemaining: number | undefined;
  /** Limit reset interval, or `undefined` for a lifetime limit. */
  limitReset: string | undefined;
  /** Whether BYOK usage counts toward the limit. */
  includeByokInLimit: boolean;
  /** Whether the key is disabled. */
  disabled: boolean;
  /** Expiration timestamp, or `undefined` if the key never expires. */
  expiresAt: string | undefined;
  /** Workspace the key belongs to. */
  workspaceId: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

export interface ApiKey extends Resource<
  "OpenRouter.ApiKey",
  ApiKeyProps,
  ApiKeyAttributes,
  never,
  Providers
> {}

/**
 * An OpenRouter API key with its own credit budget — the primitive for
 * giving each agent, tenant or environment an isolated, capped spend.
 *
 * Name, `limit`, `limitReset`, `includeByokInLimit` and `disabled` are
 * updated in place, so raising or lowering a budget never rotates the
 * secret. Changing `workspaceId` or `expiresAt` replaces the key.
 *
 * OpenRouter returns the secret only once, when the key is created. Alchemy
 * captures it into resource state as `key` (a `Redacted` value) and keeps
 * it across updates; it cannot be recovered from OpenRouter later. If the
 * key is deleted out of band, the next deploy creates a fresh key with a new
 * secret. Deploying requires a management key (`OPENROUTER_MANAGEMENT_KEY`).
 *
 * ### Creating a key
 * **Example:** Key with a monthly budget
 * ```typescript
 * const key = yield* OpenRouter.ApiKey("ResearchAgent", {
 *   limit: 25,
 *   limitReset: "monthly",
 * });
 * ```
 *
 * **Example:** Lifetime budget that never resets
 * ```typescript
 * const key = yield* OpenRouter.ApiKey("Evaluation", {
 *   name: "eval-run",
 *   limit: 5,
 * });
 * ```
 *
 * ### Pausing a key
 * **Example:** Disable a key without deleting it
 * ```typescript
 * const key = yield* OpenRouter.ApiKey("ResearchAgent", {
 *   limit: 25,
 *   limitReset: "monthly",
 *   disabled: true,
 * });
 * ```
 *
 * ### Using the key
 * **Example:** Run a language model on the key's budget
 * ```typescript
 * // `key.key` is the Redacted secret; hand it to the runtime (e.g. as a secret env var)
 * const model = OpenRouter.LanguageModel({ model: "openai/gpt-4o-mini" }).pipe(
 *   Layer.provide(OpenRouter.fromApiKey(key.key)),
 * );
 * const reply = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
 *   Effect.provide(model),
 * );
 * ```
 *
 * @resource
 * @product OpenRouter
 * @category AI
 */
export const ApiKey = Resource<ApiKey>("OpenRouter.ApiKey");

const sameInstant = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? undefined) === (b ?? undefined) ||
  (a != null && b != null && Date.parse(a) === Date.parse(b));

const toAttributes = (
  data: OpenRouter.CreateKeyResponseData,
  key: Redacted.Redacted<string>,
): ApiKeyAttributes => ({
  hash: data.hash,
  name: data.name,
  label: data.label,
  key,
  limit: data.limit ?? undefined,
  limitRemaining: data.limit_remaining ?? undefined,
  limitReset: data.limit_reset ?? undefined,
  includeByokInLimit: data.include_byok_in_limit,
  disabled: data.disabled,
  expiresAt: data.expires_at ?? undefined,
  workspaceId: data.workspace_id,
  createdAt: data.created_at,
});

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      const createKey = yield* OpenRouter.createKey;
      const getKey = yield* OpenRouter.getKey;
      const updateKey = yield* OpenRouter.updateKey;
      const deleteKey = yield* OpenRouter.deleteKey;

      const observe = (hash: string) =>
        getKey({ hash }).pipe(
          Effect.map((response) => response.data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

      return {
        // The secret is only revealed on create; reconcile carries it forward.
        stables: ["hash", "key", "workspaceId", "createdAt"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (output === undefined) return undefined;
          if (news.workspaceId !== undefined && news.workspaceId !== output.workspaceId) {
            return { action: "replace" } as const;
          }
          // Compare against the declared prop (OpenRouter may normalize the
          // timestamp's format) — any change mints a new key.
          if (!sameInstant(news.expiresAt, olds?.expiresAt)) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          // Without the cached secret there is nothing to adopt: OpenRouter
          // never reveals an existing key, and names are not unique.
          if (output === undefined) return undefined;
          const observed = yield* observe(output.hash);
          return observed ? toAttributes(observed, output.key) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = news.name ?? output?.name ?? (yield* createPhysicalName({ id }));

          // Observe — `output` is only a cache of the hash + secret.
          let observed = output ? yield* observe(output.hash) : undefined;
          let secret = output?.key;

          // Ensure — the create response is the only time the secret is
          // returned, so never retry it blindly: a retried POST could mint
          // a second, untracked key.
          if (observed === undefined || secret === undefined) {
            const created = yield* createKey({
              name,
              limit: news.limit,
              limit_reset: news.limitReset,
              include_byok_in_limit: news.includeByokInLimit,
              expires_at: news.expiresAt,
              workspace_id: news.workspaceId,
            }).pipe(OpenRouter.Retry.none);
            observed = created.data;
            secret = Redacted.make(created.key);
          }

          // Sync — PATCH only the aspects whose observed value differs.
          const desired = {
            name,
            limit: news.limit ?? null,
            limit_reset: news.limitReset ?? null,
            include_byok_in_limit: news.includeByokInLimit ?? false,
            disabled: news.disabled ?? false,
          };
          const patch: Omit<OpenRouter.UpdateKeyRequest, "hash"> = {};
          if (observed.name !== desired.name) patch.name = desired.name;
          if ((observed.limit ?? null) !== desired.limit) patch.limit = desired.limit;
          if ((observed.limit_reset ?? null) !== desired.limit_reset) {
            patch.limit_reset = desired.limit_reset;
          }
          if (observed.include_byok_in_limit !== desired.include_byok_in_limit) {
            patch.include_byok_in_limit = desired.include_byok_in_limit;
          }
          if (observed.disabled !== desired.disabled) patch.disabled = desired.disabled;
          if (Object.keys(patch).length > 0) {
            observed = (yield* updateKey({ hash: observed.hash, ...patch })).data;
          }

          return toAttributes(observed, secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteKey({ hash: output.hash }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );
