import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  type AppsSecret as StripeAppsSecret,
  GetAppsSecrets,
  GetAppsSecretsFind,
  PostAppsSecrets,
  PostAppsSecretsDelete,
  type SecretServiceResourceScope,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

const TypeId = "Stripe.AppsSecret" as const;
type TypeId = typeof TypeId;

/**
 * Upper bound on list pages walked while enumerating secrets. Stripe returns
 * at most 100 objects per page, so this caps a cold enumeration at 10k
 * objects rather than looping unbounded on a pathological account.
 */
const MAX_PAGES = 100;

/**
 * Which principal a secret is readable by.
 *
 * - `account` — shared by the app backend and every Dashboard user. Use it
 *   for values that do not vary per user, like a third-party API key.
 * - `user` — readable by the app backend and exactly one Dashboard user.
 *   Use it for per-user values like an OAuth access token.
 */
export type AppsSecretScope =
  | {
      /** Account-wide scope. */
      readonly type: "account";
    }
  | {
      /** Per-Dashboard-user scope. */
      readonly type: "user";
      /** The Stripe Dashboard user ID, e.g. `usr_1A2b3C4d5E6f`. */
      readonly user: string;
    };

export type AppsSecretProps = {
  /**
   * The secret's key — unique within its {@link AppsSecretProps.scope}.
   *
   * The name is the object's natural identity (Stripe exposes no rename
   * API and no retrieve-by-id endpoint), so changing it replaces the
   * resource: the secret is re-created under the new name and the old name
   * is deleted.
   */
  name: string;

  /**
   * The plaintext secret value to store, kept `Redacted` so it is never
   * printed by logs, traces or error messages.
   *
   * This is the only mutable field of substance — rotating it re-posts the
   * secret in place. The plaintext is **never** written to Alchemy state;
   * only a sha256 hash (`payloadHash`) is persisted, purely so `diff` can
   * detect drift.
   */
  payload: Redacted.Redacted<string>;

  /**
   * Who can read the secret. Immutable — Stripe keys a secret by
   * `(name, scope)`, so changing the scope replaces the resource.
   */
  scope: AppsSecretScope;

  /**
   * Unix timestamp (seconds) after which Stripe deletes the secret.
   * Must be in the future at the time of the deploy. Omit for a secret
   * that never expires.
   *
   * @default undefined
   */
  expiresAt?: number;
};

export type AppsSecretAttributes = {
  /** Stripe's identifier for the secret, e.g. `appsecret_1A2b3C4d5E6f`. */
  secretId: string;
  /** The secret's key, unique within {@link AppsSecretAttributes.scope}. */
  name: string;
  /** Who can read the secret. */
  scope: AppsSecretScope;
  /**
   * Unix timestamp (seconds) after which Stripe deletes the secret, or
   * `undefined` when the secret does not expire.
   */
  expiresAt: number | undefined;
  /** Unix timestamp (seconds) at which the secret was stored. */
  created: number;
  /** `true` when the secret lives in the account's live mode. */
  livemode: boolean;
  /**
   * Lowercase hex sha256 of the stored plaintext.
   *
   * Exists **only** so `diff` can notice that the desired payload no longer
   * matches what Stripe holds. The plaintext itself is never exposed in
   * attributes, never persisted to state, and never logged. An empty string
   * means "unknown" — Stripe's list endpoint redacts payloads, so rows that
   * came from enumeration carry no hash and simply reconcile on next deploy.
   */
  payloadHash: string;
};

export type AppsSecret = Resource<
  TypeId,
  AppsSecretProps,
  AppsSecretAttributes,
  never,
  Providers
>;

/**
 * A secret held in Stripe Apps' Secret Store — a key/value store that lets a
 * Stripe App persist credentials for its UI extensions and its backend,
 * scoped either to the whole account or to a single Dashboard user.
 *
 * `POST /v1/apps/secrets` is an **upsert**: posting a payload for a name that
 * already exists inside the same scope replaces the stored value rather than
 * failing with a conflict. That makes reconciliation naturally idempotent —
 * Alchemy observes the live value first and posts only when the desired
 * payload or expiry actually differs.
 *
 * Secret Store objects carry no `metadata` field, so Alchemy cannot brand
 * them with the usual `alchemy_*` ownership keys. Identity is the natural key
 * `(name, scope)`: if this resource's state row is lost, `read` re-discovers
 * the secret with `GET /v1/apps/secrets/find` and reports it as unowned so
 * the engine gates takeover behind `--adopt`.
 *
 * The payload is handled as a secret end to end. It is declared `Redacted`,
 * it never appears in the resource's attributes, and only its sha256 hash is
 * written to Alchemy state so that drift can be detected.
 *
 * ### Storing a Secret
 * **Example:** Account-scoped API key
 * ```typescript
 * const secret = yield* Stripe.AppsSecret("SendgridKey", {
 *   name: "sendgrid_api_key",
 *   scope: { type: "account" },
 *   payload: yield* Config.redacted("SENDGRID_API_KEY"),
 * });
 * ```
 *
 * **Example:** Fully configured, expiring secret
 * ```typescript
 * const token = yield* Stripe.AppsSecret("UserOauthToken", {
 *   name: "oauth_access_token",
 *   scope: { type: "user", user: "usr_1A2b3C4d5E6f" },
 *   payload: Redacted.make(accessToken),
 *   // Stripe deletes the secret at this Unix timestamp (seconds).
 *   expiresAt: Math.floor(expiry.getTime() / 1000),
 * });
 * ```
 *
 * ### Per-user secrets
 * **Example:** One secret per Dashboard user
 * ```typescript
 * const perUser = yield* Effect.forEach(dashboardUserIds, (user) =>
 *   Stripe.AppsSecret(`Token-${user}`, {
 *     name: "oauth_access_token",
 *     scope: { type: "user", user },
 *     payload: yield* Config.redacted(`OAUTH_TOKEN_${user}`),
 *   }),
 * );
 * ```
 *
 * ### Composing with other Stripe resources
 * **Example:** Stash a webhook signing secret for the app backend
 * ```typescript
 * const endpoint = yield* Stripe.WebhookEndpoint("AppEvents", {
 *   url: "https://app.example.com/stripe/webhook",
 *   enabledEvents: ["invoice.paid"],
 * });
 *
 * // The app's UI extension reads the signing secret back out of the
 * // Secret Store instead of shipping it in the bundle.
 * const signingSecret = yield* Stripe.AppsSecret("WebhookSigningSecret", {
 *   name: "webhook_signing_secret",
 *   scope: { type: "account" },
 *   payload: yield* Config.redacted("STRIPE_WEBHOOK_SIGNING_SECRET"),
 * });
 * ```
 *
 * ### Rotating and replacing
 * **Example:** Rotation is an in-place update
 * ```typescript
 * // Changing only `payload` re-posts the secret under the same name and
 * // scope. Changing `name` or `scope` replaces the resource instead.
 * const secret = yield* Stripe.AppsSecret("SendgridKey", {
 *   name: "sendgrid_api_key",
 *   scope: { type: "account" },
 *   payload: yield* Config.redacted("SENDGRID_API_KEY_V2"),
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/apps/secret_store
 *
 * @resource
 * @product Stripe
 */
export const AppsSecret = Resource<AppsSecret>(TypeId);

/** Returns true if the given value is an AppsSecret resource. */
export const isAppsSecret = (value: unknown): value is AppsSecret =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * sha256 of the plaintext, hex encoded. The only representation of a payload
 * that is ever allowed to leave this module.
 */
const hashPayload = (payload: string) =>
  Effect.sync(() => createHash("sha256").update(payload, "utf8").digest("hex"));

/** Narrow Stripe's loosely-typed scope struct back onto the resource union. */
const toScope = (scope: SecretServiceResourceScope): AppsSecretScope =>
  scope.type === "user" && scope.user !== undefined
    ? { type: "user", user: scope.user }
    : { type: "account" };

/** Shape a scope for a Stripe request — `user` is omitted for account scope. */
const toRequestScope = (
  scope: AppsSecretScope,
): { type: "account" | "user"; user?: string } =>
  scope.type === "user"
    ? { type: "user", user: scope.user }
    : { type: "account" };

/** A canonical string for a scope, for equality comparisons. */
const scopeKey = (scope: AppsSecretScope): string =>
  scope.type === "user" ? `user:${scope.user}` : "account";

const toAttributes = (
  secret: StripeAppsSecret,
  payloadHash: string,
): AppsSecretAttributes => ({
  secretId: secret.id,
  name: secret.name,
  scope: toScope(secret.scope),
  expiresAt: secret.expires_at ?? undefined,
  created: secret.created,
  livemode: secret.livemode,
  payloadHash,
});

/**
 * Stripe answers a lookup for a deleted/never-existing object with HTTP 404
 * and `type: "invalid_request_error"`, `code: "resource_missing"`. Distilled
 * dispatches on `type` before status, so that surfaces as
 * `InvalidRequestError` rather than `NotFound` — both are treated as absent.
 *
 * TODO(distilled): patch the Stripe model so `resource_missing` is typed as a
 * dedicated `NotFound`-shaped tag and this second arm can go away.
 */
const missingAsUndefined = <A, R>(
  effect: Effect.Effect<A, StripeOpError, R>,
): Effect.Effect<A | undefined, StripeOpError, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchIf(
      (e) => e._tag === "InvalidRequestError" && e.code === "resource_missing",
      () => Effect.succeed(undefined),
    ),
  );

/**
 * Look a secret up by its natural key. `GET /v1/apps/secrets/find` is the only
 * retrieve endpoint Stripe exposes for the Secret Store (there is no
 * get-by-id), and it is the only call that returns the plaintext payload.
 */
const findSecret = Effect.fn(function* (name: string, scope: AppsSecretScope) {
  const found = yield* missingAsUndefined(
    GetAppsSecretsFind({ name, scope: toRequestScope(scope) }),
  );
  // A tombstoned secret is absent as far as reconciliation is concerned.
  return found?.deleted === true ? undefined : found;
});

/**
 * Walk every page of `/v1/apps/secrets` for one scope. Bounded by
 * {@link MAX_PAGES}; Stripe pages with `starting_after` + `has_more`.
 */
const listSecrets = Effect.fn(function* (scope: AppsSecretScope) {
  const secrets: StripeAppsSecret[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetAppsSecrets({
      limit: 100,
      scope: toRequestScope(scope),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    secrets.push(...response.data.filter((s) => s.deleted !== true));
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return secrets;
});

/**
 * Hash whatever plaintext the observed object carries, then let it go. `find`
 * returns the payload; the list endpoint redacts it, in which case fall back
 * to the cached hash (or the "unknown" sentinel).
 */
const observedPayloadHash = Effect.fn(function* (
  secret: StripeAppsSecret,
  fallback: string | undefined,
) {
  if (typeof secret.payload === "string") {
    return yield* hashPayload(secret.payload);
  }
  return fallback ?? "";
});

export const AppsSecretProvider = () =>
  Provider.succeed(AppsSecret, {
    // `name` and `scope` are replace-only, and `created`/`livemode` are
    // assigned once by Stripe. `expiresAt` and `payloadHash` are the only
    // attributes an update can move.
    //
    // NOTE: `secretId` is listed as stable because Stripe's Secret Store has
    // no retrieve-by-id endpoint (the id is never used as a lookup key by
    // this provider — the natural key is). If a live test shows Stripe
    // re-issuing an id when a payload is replaced, drop it from this list.
    stables: ["secretId", "name", "scope", "created", "livemode"],

    list: Effect.fn(function* () {
      // Only account-scoped secrets are enumerable: `GET /v1/apps/secrets`
      // requires a scope, and a user scope requires knowing the Dashboard
      // user id up front. User-scoped secrets are therefore invisible to
      // enumeration and are only ever reached through their state row.
      //
      // The list endpoint redacts payloads, and deliberately no `find` call
      // is issued per row: bulk-retrieving every account secret's plaintext
      // just to compute a drift hash is not worth it. Enumerated rows carry
      // the "unknown" hash and converge on the next reconcile.
      const secrets = yield* listSecrets({ type: "account" });
      return yield* Effect.forEach(secrets, (secret) =>
        Effect.map(observedPayloadHash(secret, undefined), (hash) =>
          toAttributes(secret, hash),
        ),
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;

      // Stripe keys a secret by `(name, scope)` and exposes no rename or
      // re-scope API, so either change is a replacement.
      if (news.name !== output.name) return { action: "replace" } as const;
      if (scopeKey(news.scope) !== scopeKey(output.scope)) {
        return { action: "replace" } as const;
      }

      // Payload drift is detected through the persisted hash — never by
      // comparing plaintext, which state does not hold. An empty stored hash
      // means "unknown" (an enumerated row), which reconciles as an update
      // and then no-ops if the live value already matches.
      const payloadHash = yield* hashPayload(Redacted.value(news.payload));
      if (payloadHash !== output.payloadHash) {
        return { action: "update" } as const;
      }
      if (news.expiresAt !== output.expiresAt) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      // The Secret Store has no get-by-id endpoint, so the natural key is
      // the only way in — `secretId` is carried for reference, not lookup.
      const name = output?.name ?? olds?.name;
      const scope = output?.scope ?? olds?.scope;
      if (name === undefined || scope === undefined) return undefined;

      const observed = yield* findSecret(name, scope);
      if (observed === undefined) return undefined;

      const payloadHash = yield* observedPayloadHash(
        observed,
        output?.payloadHash,
      );
      const attrs = toAttributes(observed, payloadHash);

      // Cold read (state loss): a secret with a matching name+scope exists,
      // but with no metadata field there is nothing to prove we wrote it.
      // Gate takeover behind `--adopt` by reporting it unowned.
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const desiredPayload = Redacted.value(news.payload);
      const desiredHash = yield* hashPayload(desiredPayload);

      // 1. Observe — the natural key is authoritative; `output` is only a
      //    cache of stable identifiers, never proof the secret still exists.
      //    `find` is the one endpoint that returns the stored plaintext, so
      //    it is also how we learn whether the value already matches.
      const observed = yield* findSecret(news.name, news.scope);
      const observedHash =
        observed === undefined
          ? undefined
          : yield* observedPayloadHash(observed, output?.payloadHash);

      // 2 + 3. Ensure and sync are the same call: `POST /v1/apps/secrets` is
      //    an upsert, so creating a missing secret and replacing a stale
      //    payload/expiry are one operation. Skip the API entirely when the
      //    live value and expiry already match the desired state.
      const expiryMatches =
        (observed?.expires_at ?? undefined) === news.expiresAt;

      const secret =
        observed !== undefined && observedHash === desiredHash && expiryMatches
          ? observed
          : yield* PostAppsSecrets({
              name: news.name,
              payload: desiredPayload,
              scope: toRequestScope(news.scope),
              ...(news.expiresAt !== undefined
                ? { expires_at: news.expiresAt }
                : {}),
            });

      // 4. Return — the desired hash is authoritative once the post lands.
      return toAttributes(secret, desiredHash);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent: an already-deleted secret (or one whose scope's owner is
      // gone) is success, not an error. Deletion is keyed by name + scope
      // because Stripe exposes no delete-by-id.
      yield* missingAsUndefined(
        PostAppsSecretsDelete({
          name: output.name,
          scope: toRequestScope(output.scope),
        }),
      );
    }),
  });
