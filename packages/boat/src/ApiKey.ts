import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { boatName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/**
 * What a key may do. `read-only` inspects; `full-sandbox` operates
 * sandboxes without creating, resuming, forking or deleting them; `ci` adds
 * create, resume, fork, and delete of the sandboxes the key created;
 * `admin` is everything.
 */
export type ApiKeyPreset = "read-only" | "full-sandbox" | "ci" | "admin";

/**
 * One permission. `sandbox.delete-own` deletes only the sandboxes the key
 * created; `host` hosts a port; `account.admin` covers billing, teams,
 * webhooks and keys.
 * @see https://docs.boat.dev/api-keys/scopes
 */
export type ApiKeyAction =
  | "sandbox.create"
  | "sandbox.read"
  | "sandbox.update"
  | "sandbox.stop"
  | "sandbox.resume"
  | "sandbox.fork"
  | "sandbox.delete"
  | "sandbox.delete-own"
  | "agent.prompt"
  | "exec"
  | "file.read"
  | "file.write"
  | "ssh"
  | "desktop"
  | "host"
  | "snapshot.read"
  | "snapshot.write"
  | "environment.read"
  | "environment.write"
  | "account.read"
  | "account.admin"
  | "*";

export interface ApiKeyProps {
  /**
   * Key name. If omitted, a unique name is generated from the stack, stage
   * and logical ID. Changing it replaces the key.
   */
  name?: string;
  /**
   * A preset set of actions. Use either `preset` or `actions`; with
   * neither, the key is an `admin` key. Changing it replaces the key.
   */
  preset?: ApiKeyPreset;
  /** The actions the key may take. Changing them replaces the key. */
  actions?: ApiKeyAction[];
  /**
   * The only sandboxes the key reaches, by id. Omit to reach every
   * sandbox. Changing them replaces the key.
   */
  sandboxIds?: string[];
  /**
   * Environments whose sandboxes the key reaches, by id. Changing them
   * replaces the key.
   */
  environmentIds?: string[];
  /**
   * How long the key works: `90d`, `24h`, a number of seconds, up to
   * `365d`, or `never` for a key that works until it is revoked. A key
   * can't outlive the key that creates it: omitted, the key never expires
   * when the deployer's key doesn't, and otherwise expires with it.
   * Changing it replaces the key.
   */
  ttl?: string;
}

export interface ApiKeyAttributes {
  /** Boat's key id. */
  apiKeyId: string;
  name: string;
  /** The key (`boat_…`), sent as a bearer token. Boat shows it once; Alchemy keeps it in state. */
  key: Redacted.Redacted<string>;
  /** The key's first characters, as the dashboard shows them. */
  keyPrefix: string;
  /** The key's last four characters. */
  keyLastFour: string;
  /** When the key stops working, or `undefined` for a key that never expires. */
  expiresAt: string | undefined;
}

export interface ApiKey extends Resource<
  "Boat.ApiKey",
  ApiKeyProps,
  ApiKeyAttributes,
  never,
  Providers
> {}

/**
 * A scoped Boat API key: the actions it may take, and the sandboxes or
 * environments it reaches. Give each app or CI system its own key with
 * only what it needs.
 *
 * Boat shows a key once, when it is created, so Alchemy keeps it in state
 * as a `Redacted` value. Changing any prop creates a new key and revokes
 * the old one; destroying the resource revokes it.
 *
 * Creating a key needs a key with `account.admin`, such as the one
 * `alchemy profile edit --add Boat` signs in with. A new key cannot have
 * more actions, more sandboxes or a later expiry than the key creating it.
 * The key a browser sign-in gets lasts a year, so keys it creates expire
 * with it. An expired key is minted again on the next deploy.
 *
 * ### Creating an API key
 * **Example:** A key for CI that manages the sandboxes it creates
 * ```typescript
 * export const Ci = Boat.ApiKey("Ci", { preset: "ci", ttl: "90d" });
 * ```
 *
 * **Example:** A key that only runs commands in one sandbox
 * ```typescript
 * const box = yield* Boat.Sandbox("Box", {});
 * const key = yield* Boat.ApiKey("BoxExec", {
 *   actions: ["sandbox.read", "exec", "file.read", "file.write"],
 *   sandboxIds: [box.sandboxId],
 * });
 * ```
 *
 * @resource
 * @product API key
 */
export const ApiKey = Resource<ApiKey>("Boat.ApiKey");

const redact = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

const findById = (apiKeyId: string) =>
  boat
    .listApiKeys({})
    .pipe(Effect.map((listed) => listed.apiKeys.find((key) => key.id === apiKeyId)));

/** The props that decide what a key is; Boat can't change any of them on a key. */
const scopeOf = (props: ApiKeyProps) =>
  JSON.stringify({
    name: props.name,
    preset: props.preset,
    actions: props.actions === undefined ? undefined : [...props.actions].sort(),
    sandboxIds: props.sandboxIds === undefined ? undefined : [...props.sandboxIds].sort(),
    environmentIds:
      props.environmentIds === undefined ? undefined : [...props.environmentIds].sort(),
    ttl: props.ttl ?? "never",
  });

const attributesOf = (key: boat.ApiKey, secret: Redacted.Redacted<string>): ApiKeyAttributes => ({
  apiKeyId: key.id,
  name: key.name,
  key: secret,
  keyPrefix: key.keyPrefix,
  keyLastFour: key.keyLastFour,
  expiresAt: key.expiresAt ?? undefined,
});

/**
 * Seconds until the signing key expires, from Boat's refusal ("…signed
 * with an API key that expires 2027-11-07T16:21:12.757Z…"), less a minute;
 * Boat's 90-day default when the message names no date.
 */
const ttlUntilSignerExpires = (message: string | undefined) => {
  const expires = /expires (\S+?Z)/.exec(message ?? "")?.[1];
  const seconds =
    expires === undefined ? Number.NaN : (Date.parse(expires) - Date.now()) / 1000 - 60;
  return Number.isFinite(seconds) && seconds > 60 ? String(Math.floor(seconds)) : "90d";
};

/** Revoke a key; revoking one that is gone succeeds. */
export const revokeApiKey = (apiKeyId: string) =>
  boat.revokeApiKey({ apiKeyId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      return {
        stables: ["apiKeyId", "key", "keyPrefix", "keyLastFour"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (scopeOf(news) !== scopeOf(olds)) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          // Boat never returns a key's value after creation, so a key is
          // only usable through state.
          if (output === undefined) return undefined;
          const key = yield* findById(output.apiKeyId);
          if (key === undefined || key.expired === true) return undefined;
          const attrs = attributesOf(key, output.key);
          return olds !== undefined || isGeneratedName(key.name) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* boatName(id, news.name ?? output?.name);

          // Observe — a key is usable only while its value is in state.
          const observed = output === undefined ? undefined : yield* findById(output.apiKeyId);
          if (output !== undefined && observed !== undefined && observed.expired !== true) {
            return attributesOf(observed, output.key);
          }

          // Ensure
          yield* session.note(`Creating API key ${name}...`);
          const create = (ttl: string) =>
            boat.createScopedApiKey({
              name,
              ttl,
              ...(news.preset === undefined ? {} : { preset: news.preset }),
              ...(news.actions === undefined ? {} : { actions: news.actions }),
              ...(news.sandboxIds === undefined ? {} : { sandboxIds: news.sandboxIds }),
              ...(news.environmentIds === undefined ? {} : { environmentIds: news.environmentIds }),
            });
          const created = yield* create(news.ttl ?? "never").pipe(
            // Without a `ttl`, the longest Boat allows: as long as the key
            // signing the request, whose expiry Boat names in the refusal.
            Effect.catchTag("ApiKeyOutlivesSigner", (error) =>
              news.ttl === undefined
                ? Effect.suspend(() => create(ttlUntilSignerExpires(error.message)))
                : Effect.fail(error),
            ),
          );
          return attributesOf(created.apiKey, redact(created.secret));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* revokeApiKey(output.apiKeyId);
        }),
        // For nuke. Listed keys carry no value; delete needs only the id.
        list: Effect.fn(function* () {
          const listed = yield* boat.listApiKeys({});
          return listed.apiKeys
            .filter((key) => isGeneratedName(key.name))
            .map((key) => attributesOf(key, Redacted.make("")));
        }),
      };
    }),
  );
