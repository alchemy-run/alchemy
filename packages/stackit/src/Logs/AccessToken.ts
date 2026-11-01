import * as logs from "@distilled.cloud/stackit/logs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  diffLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  managedLabels,
  reservedLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwned,
  generatedDisplayName,
  INSTANCE_TIMEOUT,
  listInstances,
  scopeRequest,
  toRedacted,
  userLabels,
} from "./internal.ts";

/** What a token allows on its instance's logs. */
export type AccessTokenPermission = "read" | "write";

export interface AccessTokenProps {
  /** Instance the token belongs to. Changing it replaces the token. */
  instanceId: string;
  /** What the token allows. The API can't change it, so changing it replaces the token. */
  permissions: AccessTokenPermission[];
  /**
   * Name shown in the STACKIT portal: 1 to 32 characters, starting with a letter, then
   * letters, digits, `_`, `-` and spaces. Updates in place.
   *
   * @default a name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * Days until the token expires, from 1 to 180. The API can't change it, so changing it
   * replaces the token. A deploy after the token expired replaces it too.
   *
   * @default the token doesn't expire
   */
  lifetime?: number;
  /**
   * Description, at most 100 characters. Updates in place; omit to leave the live value
   * alone.
   */
  description?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project that owns the instance. Changing it replaces the token. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the token. @default the profile's region */
  region?: string;
}

export interface AccessTokenAttributes {
  /** STACKIT access token id (UUID). */
  accessTokenId: string;
  /** Instance the token belongs to. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /**
   * The token, `Redacted`. The API returns it only when it is created, so it is
   * `undefined` on a token taken over with `--adopt`.
   */
  accessToken: Redacted.Redacted<string> | undefined;
  /** Whether the token was taken over with `--adopt`, so Alchemy never had its value. */
  adopted: boolean;
  /** Root URL of the instance the token belongs to, which the data bindings call. */
  datasourceUrl: string | undefined;
  /** Name shown in the STACKIT portal. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** What the token allows. */
  permissions: string[];
  /** The `lifetime` the token was created with, when Alchemy created it. */
  lifetime: number | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Who created the token. */
  creator: string;
  /** Whether the token can expire. */
  expires: boolean;
  /** `active` or `expired`. */
  status: logs.AccessTokenStatus;
  /** Last moment the token is valid, when it can expire. */
  validUntil: string | undefined;
}

export type AccessToken = Resource<
  "Stackit.Logs.AccessToken",
  AccessTokenProps,
  AccessTokenAttributes,
  never,
  Providers
>;

/** STACKIT answered a token's create without the value it only returns from that call. */
export class AccessTokenValueMissing extends Data.TaggedError(
  "Stackit.Logs.AccessTokenValueMissing",
)<{
  readonly displayName: string;
  readonly message: string;
}> {}

/**
 * An access token of a `Stackit.Logs.Instance`, for reading or writing its logs with
 * `Stackit.Logs.ReadInstance`, `WriteInstance` or `ReadWriteInstance`, or with any Loki
 * or OTLP client. The value stays `Redacted`.
 *
 * STACKIT returns the value only when the token is created. A deploy that crashes before
 * saving it finds the token by its labels on the next run, deletes it and creates a new
 * one. A token with the same `displayName` that lacks those labels is reported as
 * unowned; taking it over with `--adopt` leaves `accessToken` `undefined`, because no API
 * can return its value.
 *
 * Changing `instanceId`, `permissions`, `lifetime`, `projectId` or `region` replaces the
 * token, and so does a deploy after it expired, which a host holding the old value only
 * sees once it redeploys. With an explicit `displayName` the old token is deleted first.
 *
 * ### Creating a Token
 * **Example:** A token that reads and writes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", { acl: ["203.0.113.7/32"] });
 * const token = yield* Stackit.Logs.AccessToken("Writer", {
 *   instanceId: logs.instanceId,
 *   permissions: ["read", "write"],
 * });
 * ```
 *
 * **Example:** A write-only token that expires after 30 days
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", { acl: ["203.0.113.7/32"] });
 * const token = yield* Stackit.Logs.AccessToken("Shipper", {
 *   instanceId: logs.instanceId,
 *   permissions: ["write"],
 *   lifetime: 30,
 *   description: "Log shipper",
 * });
 * ```
 *
 * ### Using the Token in a Runtime
 * **Example:** Push from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 * export const Shipper = Logs.pipe(
 *   Effect.flatMap((logs) =>
 *     Stackit.Logs.AccessToken("Shipper", {
 *       instanceId: logs.instanceId,
 *       permissions: ["write"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.WriteInstance(yield* Shipper);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* logs.push({
 *           streams: [{ stream: { app: "api" }, values: [[`${Date.now()}000000`, "hello"]] }],
 *         });
 *         return HttpServerResponse.empty();
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing `permissions` makes a new token
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", { acl: ["203.0.113.7/32"] });
 * // The API can't update permissions. A host bound to the token gets the new value
 * // on the same deploy; anything else holding the old value stops working.
 * const token = yield* Stackit.Logs.AccessToken("Writer", {
 *   instanceId: logs.instanceId,
 *   permissions: ["write"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Logs
 * @category Logs
 */
export const AccessToken = Resource<AccessToken>("Stackit.Logs.AccessToken");

/** What a token carries over from before this observation. */
interface KnownToken {
  readonly accessToken: Redacted.Redacted<string> | undefined;
  readonly adopted: boolean;
  readonly lifetime: number | undefined;
  readonly datasourceUrl: string | undefined;
}

const toAttrs = (
  scope: ProjectScope,
  instanceId: string,
  token: logs.AccessToken,
  known: KnownToken,
): AccessTokenAttributes => ({
  accessTokenId: token.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  accessToken: known.accessToken,
  adopted: known.adopted,
  datasourceUrl: known.datasourceUrl,
  displayName: token.displayName,
  description: token.description === "" ? undefined : token.description,
  permissions: [...token.permissions],
  lifetime: known.lifetime,
  labels: userLabels(token.labels),
  creator: token.creator,
  expires: token.expires,
  status: token.status,
  validUntil: token.validUntil,
});

const getTokenOrUndefined = (scope: ProjectScope, instanceId: string, tId: string) =>
  logs
    .getAccessToken({ ...scopeRequest(scope), instanceId, tId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** An instance's tokens, or none once the instance is gone. The API doesn't page this list. */
const listTokens = (scope: ProjectScope, instanceId: string) =>
  logs.listAccessTokens({ ...scopeRequest(scope), instanceId }).pipe(
    Effect.map(({ tokens }) => tokens),
    Effect.catchTag("NotFound", () => Effect.succeed<logs.AccessToken[]>([])),
  );

const deleteToken = (scope: ProjectScope, instanceId: string, tId: string) =>
  logs.deleteAccessToken({ ...scopeRequest(scope), instanceId, tId }).pipe(
    Effect.retry(conflictRetry),
    Effect.catchTag("NotFound", () => Effect.void),
  );

const labelsDrifted = (token: logs.AccessToken, labels: Record<string, string>): boolean => {
  const { upsert, removed } = diffLabels(managedLabels(token.labels), labels);
  return upsert.length > 0 || removed.length > 0;
};

export const AccessTokenProvider = () =>
  Provider.succeed(AccessToken, {
    stables: ["instanceId", "projectId", "region", "datasourceUrl"],
    nuke: { dependsOn: ["Stackit.Logs.Instance"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listInstances(scope);
      const found: AccessTokenAttributes[] = [];
      for (const instance of instances.filter((item) => isAlchemyOwned(item.labels))) {
        const tokens = yield* listTokens(scope, instance.id);
        for (const token of tokens.filter((item) => isAlchemyOwned(item.labels))) {
          found.push(
            toAttrs(scope, instance.id, token, {
              accessToken: undefined,
              adopted: false,
              lifetime: undefined,
              datasourceUrl: instance.datasourceUrl,
            }),
          );
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A generated name carries the generation; an explicit one may not exist twice.
      const deleteFirst = rawProp<AccessTokenProps>(news, "displayName") !== undefined;
      if (
        hasUnresolvedTrigger<AccessTokenProps>(news, [
          "instanceId",
          "permissions",
          "lifetime",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<AccessTokenProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The API doesn't report a lifetime, so `olds` is all there is. On an adopted row
      // there is none, and the live token stands.
      if (
        !sameMembers(resolved.permissions, output.permissions) ||
        (olds !== undefined && resolved.lifetime !== olds.lifetime)
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      // `read` doesn't run at plan for a created row: expiry is noticed here.
      const now = yield* Clock.currentTimeMillis;
      const expired =
        output.status === "expired" ||
        (output.expires &&
          output.validUntil !== undefined &&
          new Date(output.validUntil).getTime() <= now);
      if (expired && !output.adopted) return { action: "replace", deleteFirst } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId: generationId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const instance = yield* logs
        .getLogsInstance({ ...scopeRequest(scope), instanceId })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (instance === undefined) return undefined;
      const known: KnownToken = {
        accessToken: output?.accessToken,
        adopted: output?.adopted ?? false,
        lifetime: output?.lifetime ?? olds?.lifetime,
        datasourceUrl: instance.datasourceUrl,
      };
      if (output !== undefined) {
        const byId = yield* getTokenOrUndefined(scope, instanceId, output.accessTokenId);
        if (byId !== undefined) return toAttrs(scope, instanceId, byId, known);
      }
      const tokens = yield* listTokens(scope, instanceId);
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId: generationId, output, previous });
      const owned = yield* findOwned(id, tokens, generation);
      if (owned !== undefined) return toAttrs(scope, instanceId, owned, known);
      const name = output?.displayName ?? olds?.displayName;
      const named = tokens.find((token) => token.displayName === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, named, known);
      // A token id is only unique on its instance, and an instance id per scope.
      const isPrevious =
        previous?.accessTokenId === named.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId: generationId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      const request = { ...scopeRequest(scope), instanceId };
      const displayName = news.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, generationId, news.labels);
      // `output` only speaks for this token while it sits on the desired instance.
      const cached =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;

      // First, so nothing after the create can fail and lose the value.
      const { datasourceUrl } = yield* waitFor({
        resource: `STACKIT Logs instance ${instanceId}`,
        read: logs.getLogsInstance(request),
        ready: (instance) => instance.datasourceUrl !== undefined,
        state: (instance) => instance.status,
        timeout: INSTANCE_TIMEOUT,
        interval: "5 seconds",
        maxInterval: "15 seconds",
      });

      // 1. Observe — by cached id, then by this generation's labels (a crashed create).
      let current: logs.AccessToken | undefined;
      if (cached !== undefined) {
        current = yield* getTokenOrUndefined(scope, instanceId, cached.accessTokenId);
      }
      if (current === undefined) {
        const tokens = yield* listTokens(scope, instanceId);
        current = yield* findOwned(id, tokens, generationId);
      }

      let accessToken = current === undefined ? undefined : cached?.accessToken;
      // No value and labels of this generation: Alchemy created it and a crash lost the
      // value. No value and no such labels: it was taken over with `--adopt`, nobody here
      // can tell who holds its value, and it is never recreated.
      const adopted =
        current !== undefined &&
        (cached?.adopted === true ||
          (accessToken === undefined && !hasInstanceLabel(generationId, current.labels)));

      // A token with no known value, or an expired one, is useless to what it is bound
      // to, and can't be repaired.
      if (
        current !== undefined &&
        !adopted &&
        (accessToken === undefined || current.status === "expired")
      ) {
        yield* deleteToken(scope, instanceId, current.id);
        current = undefined;
        accessToken = undefined;
      }

      // 2. Ensure — the response holds the only copy of the value.
      if (current === undefined) {
        const created = yield* logs.createAccessToken({
          ...request,
          displayName,
          permissions: [...news.permissions],
          labels,
          ...(news.lifetime !== undefined ? { lifetime: news.lifetime } : {}),
          ...(news.description !== undefined ? { description: news.description } : {}),
        });
        if (created.accessToken === undefined) {
          yield* deleteToken(scope, instanceId, created.id);
          return yield* new AccessTokenValueMissing({
            displayName,
            message: `STACKIT created Logs access token ${displayName} without returning its value`,
          });
        }
        return toAttrs(scope, instanceId, created, {
          accessToken: toRedacted(created.accessToken),
          adopted: false,
          lifetime: news.lifetime,
          datasourceUrl,
        });
      }

      // 3. Sync — observed name, description and labels against the desired ones. The
      // API answers 204, and whether PUT clears an omitted field is undocumented, so it
      // carries all three.
      const known: KnownToken = {
        accessToken,
        adopted,
        lifetime: news.lifetime ?? cached?.lifetime,
        datasourceUrl,
      };
      if (
        current.displayName !== displayName ||
        (news.description !== undefined && (current.description ?? "") !== news.description) ||
        labelsDrifted(current, labels)
      ) {
        const description = news.description ?? current.description;
        yield* logs
          .updateAccessToken({
            ...request,
            tId: current.id,
            displayName,
            labels: { ...reservedLabels(current.labels), ...labels },
            ...(description !== undefined ? { description } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        current = yield* logs.getAccessToken({ ...request, tId: current.id });
      }

      // 4. Return
      return toAttrs(scope, instanceId, current, known);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* deleteToken(scope, output.instanceId, output.accessTokenId);
    }),
  });
