import * as router from "@distilled.cloud/stackit/telemetry_router";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  conflictRetry,
  emptyToUndefined,
  generatedDisplayName,
  isGeneratedDisplayName,
} from "../internal/displayNames.ts";
import { waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  getRouterOrUndefined,
  listOwnedRouters,
  listRouterAccessTokens,
  onRegion,
  POLL,
  TELEMETRY_TIMEOUT,
  type RouterScope,
} from "./internal.ts";

export interface AccessTokenProps {
  /** Id of the router the token is for. Changing it replaces the token. */
  routerId: string;
  /**
   * Name of the token: 1 to 32 letters, digits, spaces and hyphens, starting with a
   * letter or digit. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * Description: letters, digits, spaces and hyphens only, at most 1024 characters.
   * Updates in place; omit to leave the live value alone.
   */
  description?: string;
  /**
   * Days until the token expires. The API has no way to change this on a token, so
   * changing it replaces the token. A deploy after the token expired replaces it too.
   *
   * @default the token doesn't expire
   */
  ttlDays?: number;
  /**
   * Any value. Changing it replaces the token, so `accessToken` holds a new one. STACKIT
   * only returns a token when it creates one, so set this on an adopted token to get a
   * usable `accessToken`. Removing it changes nothing.
   */
  rotationKey?: string;
  /** Project of the router. Changing it replaces the token. @default the profile's project */
  projectId?: string;
  /** Region of the router. Changing it replaces the token. @default the profile's region */
  region?: string;
}

export interface AccessTokenAttributes {
  /** STACKIT access token id (UUID). Stable across updates. */
  accessTokenId: string;
  /** Id of the router the token is for. */
  routerId: string;
  /** Project of the router. */
  projectId: string;
  /** Region of the router. */
  region: string;
  /**
   * The token, a JWT. `undefined` for a token Alchemy adopted by its explicit name,
   * until `rotationKey` is set. A generated-name token that lost its value to a crashed
   * deploy gets a new one from the next deploy.
   */
  accessToken: Redacted.Redacted<string> | undefined;
  /** Name of the token. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** `ttlDays` the token was created with. */
  ttlDays: number | undefined;
  /** The `rotationKey` the token was created with. */
  rotationKey: string | undefined;
  /** Status: `active` or `expired`. */
  status: string;
  /** The last moment the token is valid (RFC 3339), if it expires. */
  expirationTime: string | undefined;
  /** User id of the creator. */
  creatorId: string;
}

export type AccessToken = Resource<
  "Stackit.Telemetry.AccessToken",
  AccessTokenProps,
  AccessTokenAttributes,
  never,
  Providers
>;

/**
 * An access token for a `Stackit.Telemetry.Router`. A `Stackit.Telemetry.Link` needs
 * one to send logs to the router.
 *
 * STACKIT generates the token and only returns it on create. Alchemy keeps it `Redacted`
 * in the `accessToken` attribute. If a deploy crashes before saving a generated-name
 * token, the next deploy deletes it and creates a new one: the token can only be
 * Alchemy's, and nobody can hold its value.
 *
 * The name and description update in place. `ttlDays` can't change on a token, so
 * changing it replaces the token, as does `rotationKey`. A deploy after `expirationTime`
 * also replaces it. Between deploys nothing renews an expired token, so a link using it
 * stops until the next deploy.
 *
 * Tokens have no labels. Without state, a generated name proves a token is Alchemy's,
 * and an explicit name found on the router is reported as unowned, and only taken over
 * with `--adopt`, which leaves `accessToken` empty until `rotationKey` is set.
 *
 * ### Creating a Token
 * **Example:** A token that doesn't expire
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * const token = yield* Stackit.Telemetry.AccessToken("LinkToken", {
 *   routerId: router.routerId,
 * });
 * // token.accessToken is Redacted: hand it to a link or a secret store, never log it.
 * ```
 *
 * **Example:** A token that expires after 90 days
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * const token = yield* Stackit.Telemetry.AccessToken("LinkToken", {
 *   routerId: router.routerId,
 *   displayName: "audit-link",
 *   description: "Used by the project link",
 *   ttlDays: 90,
 * });
 * ```
 *
 * ### Rotating a Token
 * **Example:** Get a new token by changing `rotationKey`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * // A generated name lets the new token exist before the old one is deleted.
 * const token = yield* Stackit.Telemetry.AccessToken("LinkToken", {
 *   routerId: router.routerId,
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export const AccessToken = Resource<AccessToken>("Stackit.Telemetry.AccessToken");

type LiveToken = router.AccessTokenBaseResponse;

const toAttrs = (
  scope: RouterScope,
  routerId: string,
  live: LiveToken,
  kept: Pick<AccessTokenAttributes, "accessToken" | "ttlDays" | "rotationKey">,
): AccessTokenAttributes => ({
  accessTokenId: live.id,
  routerId,
  projectId: scope.projectId,
  region: scope.region,
  accessToken: kept.accessToken,
  displayName: live.displayName,
  description: emptyToUndefined(live.description),
  ttlDays: kept.ttlDays,
  rotationKey: kept.rotationKey,
  status: live.status,
  expirationTime: live.expirationTime ?? undefined,
  creatorId: live.creatorId,
});

const getOrUndefined = (scope: RouterScope, telemetryRouterId: string, accessTokenId: string) =>
  router
    .getAccessToken({ ...onRegion(scope), telemetryRouterId, accessTokenId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (scope: RouterScope, telemetryRouterId: string, name: string) =>
  listRouterAccessTokens(scope, telemetryRouterId).pipe(
    Effect.map((tokens) => tokens.find((token) => token.displayName === name)),
  );

/** Delete a token and wait until it is gone. Idempotent. */
const deleteAndWait = (scope: RouterScope, telemetryRouterId: string, accessTokenId: string) =>
  Effect.gen(function* () {
    yield* router.deleteAccessToken({ ...onRegion(scope), telemetryRouterId, accessTokenId }).pipe(
      Effect.retry(conflictRetry),
      Effect.catchTag("NotFound", () => Effect.void),
    );
    yield* waitUntilGone({
      resource: `STACKIT Telemetry Router access token ${accessTokenId}`,
      read: getOrUndefined(scope, telemetryRouterId, accessTokenId),
      state: (live) => live.status,
      timeout: TELEMETRY_TIMEOUT,
      ...POLL,
    });
  });

/** Whether a token is past the time the API said it is valid until. */
const isExpired = (output: AccessTokenAttributes, now: number) =>
  output.status === "expired" ||
  (output.expirationTime !== undefined && Date.parse(output.expirationTime) < now);

export const AccessTokenProvider = () =>
  Provider.succeed(AccessToken, {
    stables: ["accessTokenId", "routerId", "projectId", "region", "creatorId"],
    nuke: { dependsOn: ["Stackit.Telemetry.Router"] },

    // Only generated names: a token someone added to our router by hand isn't ours.
    list: Effect.fn(function* () {
      const scope = yield* resolveProjectScope(undefined, undefined);
      const routers = yield* listOwnedRouters(scope);
      const found: AccessTokenAttributes[] = [];
      for (const owner of routers) {
        const tokens = yield* listRouterAccessTokens(scope, owner.id);
        for (const live of tokens) {
          if (isGeneratedDisplayName(live.displayName)) {
            found.push(
              toAttrs(scope, owner.id, live, {
                accessToken: undefined,
                ttlDays: undefined,
                rotationKey: undefined,
              }),
            );
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (output === undefined) return undefined;
      // A generated name carries the generation, so the new token can exist first and a
      // link can move to it. An explicit name survives the replacement.
      const deleteFirst = rawProp<AccessTokenProps>(news, "displayName") !== undefined;
      if (
        hasUnresolvedTrigger<AccessTokenProps>(news, [
          "routerId",
          "projectId",
          "region",
          "ttlDays",
          "rotationKey",
        ])
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<AccessTokenProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.routerId !== output.routerId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The API doesn't report a token's `ttl`, so only deployed props can tell it changed.
      const ttlChanged = olds !== undefined && resolved.ttlDays !== olds.ttlDays;
      const rotated =
        resolved.rotationKey !== undefined && resolved.rotationKey !== output.rotationKey;
      // `read` doesn't run for a created row at plan, so expiry is noticed here.
      const now = yield* Clock.currentTimeMillis;
      if (ttlChanged || rotated || isExpired(output, now)) {
        return { action: "replace", deleteFirst } as const;
      }
      // A generated-name token whose value a crash lost: reconcile recreates it.
      if (
        output.accessToken === undefined &&
        output.displayName === (yield* generatedDisplayName(id))
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const routerId = output?.routerId ?? olds?.routerId;
      if (routerId === undefined) return undefined;
      const kept = {
        accessToken: output?.accessToken,
        ttlDays: output?.ttlDays ?? olds?.ttlDays,
        rotationKey: output?.rotationKey ?? olds?.rotationKey,
      };
      if (output?.accessTokenId !== undefined) {
        const byId = yield* getOrUndefined(scope, routerId, output.accessTokenId);
        if (byId !== undefined && byId.status !== "deleting") {
          return toAttrs(scope, routerId, byId, kept);
        }
      }
      if ((yield* getRouterOrUndefined(scope, routerId)) === undefined) return undefined;
      const name = output?.displayName ?? olds?.displayName ?? (yield* generatedDisplayName(id));
      const found = yield* findByName(scope, routerId, name);
      if (found === undefined || found.status === "deleting") return undefined;
      const attrs = toAttrs(scope, routerId, found, kept);
      // No labels: a generated name carries this generation's id, so it is ours. An
      // explicit name proves nothing, unless it is the generation being replaced.
      return olds?.displayName === undefined || previous?.accessTokenId === found.id
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const routerId = news.routerId;
      const generatedName = yield* generatedDisplayName(id);
      const displayName = news.displayName ?? output?.displayName ?? generatedName;
      const generated = displayName === generatedName;
      const known =
        output?.routerId === routerId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;

      // 1. Observe — by cached id, then by a generated name (a crashed create). Only
      // this generation's generated name proves a token is ours.
      let live: LiveToken | undefined;
      if (known !== undefined) {
        live = yield* getOrUndefined(scope, routerId, known.accessTokenId);
      }
      if (live === undefined && generated) {
        live = yield* findByName(scope, routerId, displayName);
      }

      // A token that can't serve: expired, or being deleted. So is one with a generated
      // name and no known value: a crash after the create lost the only copy, and nobody
      // can hold it. An explicit name with no value can be an adopted token someone else
      // holds, so it stays.
      if (
        live !== undefined &&
        (live.status !== "active" || (generated && known?.accessToken === undefined))
      ) {
        yield* deleteAndWait(scope, routerId, live.id);
        live = undefined;
      }

      // 2. Ensure — the response holds the only copy of the token. Nothing can fail
      // between it and the return, so it can't be lost to a later step.
      if (live === undefined) {
        const created = yield* router
          .createAccessToken({
            ...onRegion(scope),
            telemetryRouterId: routerId,
            displayName,
            ...(news.description !== undefined ? { description: news.description } : {}),
            ...(news.ttlDays !== undefined ? { ttl: news.ttlDays } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        const { accessToken, ...rest } = created;
        return toAttrs(scope, routerId, rest, {
          accessToken: typeof accessToken === "string" ? Redacted.make(accessToken) : accessToken,
          ttlDays: news.ttlDays,
          rotationKey: news.rotationKey,
        });
      }

      // 3. Sync — the name and description against the live token.
      const patch = {
        ...(live.displayName !== displayName ? { displayName } : {}),
        ...(news.description !== undefined && (live.description ?? "") !== news.description
          ? { description: news.description }
          : {}),
      };
      if (Object.keys(patch).length > 0) {
        live = yield* router
          .updateAccessToken({
            ...onRegion(scope),
            telemetryRouterId: routerId,
            accessTokenId: live.id,
            ...patch,
          })
          .pipe(Effect.retry(conflictRetry));
      }

      // 4. Return
      return toAttrs(scope, routerId, live, {
        accessToken: known?.accessToken,
        ttlDays: news.ttlDays,
        rotationKey: news.rotationKey ?? known?.rotationKey,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteAndWait(
        { projectId: output.projectId, region: output.region },
        output.routerId,
        output.accessTokenId,
      );
    }),
  });
