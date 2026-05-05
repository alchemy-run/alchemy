import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { AiGatewayBinding } from "./AiGatewayBinding.ts";

export type AiGatewayRateLimitingTechnique = "fixed" | "sliding";

export type AiGatewayLogManagementStrategy = "STOP_INSERTING" | "DELETE_OLDEST";

export type AiGatewayDlp =
  | {
      /**
       * Action to take when a DLP profile matches.
       */
      action: "BLOCK" | "FLAG";
      /**
       * Whether DLP is enabled.
       */
      enabled: boolean;
      /**
       * DLP profile identifiers to apply.
       */
      profiles: string[];
    }
  | {
      /**
       * Whether DLP is enabled.
       */
      enabled: boolean;
      /**
       * DLP policies to apply.
       */
      policies: {
        /**
         * DLP policy identifier.
         */
        id: string;
        /**
         * Action to take when the policy matches.
         */
        action: "FLAG" | "BLOCK";
        /**
         * Request or response phases checked by the policy.
         */
        check: ("REQUEST" | "RESPONSE")[];
        /**
         * Whether the policy is enabled.
         */
        enabled: boolean;
        /**
         * DLP profile identifiers to apply.
         */
        profiles: string[];
      }[];
    };

export type AiGatewayOtel = {
  /**
   * Authorization header value for the OpenTelemetry endpoint.
   */
  authorization: string;
  /**
   * Additional headers sent to the OpenTelemetry endpoint.
   */
  headers: Record<string, unknown>;
  /**
   * OpenTelemetry endpoint URL.
   */
  url: string;
};

export type AiGatewayStripe = {
  /**
   * Authorization header value for Stripe usage events.
   */
  authorization: string;
  /**
   * Stripe usage event payload definitions.
   */
  usageEvents: {
    /**
     * Usage event payload.
     */
    payload: string;
  }[];
};

export type AiGatewayProps = {
  /**
   * Gateway identifier. If omitted, a unique ID will be generated.
   *
   * Must be 1-64 characters and match Cloudflare's AI Gateway ID pattern:
   * lowercase letters, numbers, underscores, and hyphens.
   *
   * @default ${app}-${stage}-${id}
   */
  id?: string;
  /**
   * Whether cached responses are invalidated when a request changes.
   *
   * @default false
   */
  cacheInvalidateOnUpdate?: boolean;
  /**
   * Cache time-to-live in seconds. Set to `null` to disable caching.
   *
   * @default null
   */
  cacheTtl?: number | null;
  /**
   * Whether AI Gateway stores request logs.
   *
   * @default true
   */
  collectLogs?: boolean;
  /**
   * Rate limiting interval in seconds. Set to `null` to disable rate limiting.
   *
   * @default null
   */
  rateLimitingInterval?: number | null;
  /**
   * Maximum requests allowed during the rate limiting interval. Set to `null`
   * to disable rate limiting.
   *
   * @default null
   */
  rateLimitingLimit?: number | null;
  /**
   * Rate limiting algorithm.
   *
   * @default "fixed"
   */
  rateLimitingTechnique?: AiGatewayRateLimitingTechnique;
  /**
   * Whether gateway authentication is enabled.
   */
  authentication?: boolean;
  /**
   * DLP configuration. The installed distilled Cloudflare client applies this
   * through the update API after gateway creation.
   */
  dlp?: AiGatewayDlp;
  /**
   * Whether this gateway is the account default.
   */
  isDefault?: boolean;
  /**
   * Maximum number of log entries to retain.
   */
  logManagement?: number | null;
  /**
   * Strategy used when retained logs reach `logManagement`.
   */
  logManagementStrategy?: AiGatewayLogManagementStrategy | null;
  /**
   * Whether Logpush is enabled for this gateway.
   */
  logpush?: boolean;
  /**
   * Public key used for Logpush encryption.
   */
  logpushPublicKey?: string | null;
  /**
   * OpenTelemetry export configuration.
   */
  otel?: AiGatewayOtel[] | null;
  /**
   * Store identifier used by the gateway.
   */
  storeId?: string | null;
  /**
   * Stripe usage export configuration.
   */
  stripe?: AiGatewayStripe | null;
  /**
   * Whether Zero Data Retention is enabled.
   */
  zdr?: boolean;
};

export type AiGateway = Resource<
  "Cloudflare.AiGateway",
  AiGatewayProps,
  {
    gatewayId: string;
    accountId: string;
    accountTag: string | undefined;
    internalId: string | undefined;
    cacheInvalidateOnUpdate: boolean;
    cacheTtl: number | null;
    collectLogs: boolean;
    createdAt: string;
    modifiedAt: string;
    rateLimitingInterval: number | null;
    rateLimitingLimit: number | null;
    rateLimitingTechnique: AiGatewayRateLimitingTechnique;
    authentication: boolean | undefined;
    dlp: AiGatewayDlp | null | undefined;
    isDefault: boolean | undefined;
    logManagement: number | null | undefined;
    logManagementStrategy: AiGatewayLogManagementStrategy | null | undefined;
    logpush: boolean | undefined;
    logpushPublicKey: string | null | undefined;
    otel: AiGatewayOtel[] | null | undefined;
    storeId: string | null | undefined;
    stripe: AiGatewayStripe | null | undefined;
    zdr: boolean | undefined;
  },
  never,
  Providers
>;

// Cloudflare's AI Gateway API uses 0 to mean "disabled" for cache TTL and
// rate limiting fields. Normalize back to null so user-facing semantics
// match what was passed in.
const nullIfZero = (value: number | null | undefined): number | null =>
  value == null || value === 0 ? null : value;

export const isAiGateway = (value: unknown): value is AiGateway =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AiGateway).Type === "Cloudflare.AiGateway";

/**
 * A Cloudflare AI Gateway for observability, caching, rate limiting, and
 * governance across AI provider requests.
 *
 * AI Gateway gives your application a stable gateway ID and account-scoped
 * endpoint that can route model requests through Cloudflare.
 *
 * @section Creating a Gateway
 * @example Basic gateway
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway");
 * ```
 *
 * @example Gateway with caching and rate limiting
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway", {
 *   id: "my-gateway",
 *   cacheTtl: 300,
 *   cacheInvalidateOnUpdate: true,
 *   rateLimitingInterval: 60,
 *   rateLimitingLimit: 100,
 *   rateLimitingTechnique: "sliding",
 * });
 * ```
 *
 * @section Logging
 * @example Gateway with log retention
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway", {
 *   collectLogs: true,
 *   logManagement: 10000,
 *   logManagementStrategy: "STOP_INSERTING",
 * });
 * ```
 */
export const AiGateway = Resource<AiGateway>("Cloudflare.AiGateway")({
  /**
   * Bind this gateway to the surrounding Worker, returning an Effect-native
   * client for the runtime AI Gateway binding.
   */
  bind: AiGatewayBinding.bind,
});

export const AiGatewayProvider = () =>
  Provider.effect(
    AiGateway,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createAiGateway = yield* aiGateway.createAiGateway;
      const getAiGateway = yield* aiGateway.getAiGateway;
      const updateAiGateway = yield* aiGateway.updateAiGateway;
      const deleteAiGateway = yield* aiGateway.deleteAiGateway;

      const createGatewayId = (id: string, gatewayId: string | undefined) =>
        Effect.gen(function* () {
          if (gatewayId) return gatewayId;
          return yield* createPhysicalName({
            id,
            maxLength: 64,
            lowercase: true,
          });
        });

      const desired = (id: string, props: AiGatewayProps | undefined) =>
        Effect.gen(function* () {
          return {
            gatewayId: yield* createGatewayId(id, props?.id),
            cacheInvalidateOnUpdate: props?.cacheInvalidateOnUpdate ?? false,
            cacheTtl: props?.cacheTtl ?? null,
            collectLogs: props?.collectLogs ?? true,
            rateLimitingInterval: props?.rateLimitingInterval ?? null,
            rateLimitingLimit: props?.rateLimitingLimit ?? null,
            rateLimitingTechnique: props?.rateLimitingTechnique ?? "fixed",
            authentication: props?.authentication,
            dlp: props?.dlp,
            isDefault: props?.isDefault,
            logManagement: props?.logManagement,
            logManagementStrategy: props?.logManagementStrategy,
            logpush: props?.logpush,
            logpushPublicKey: props?.logpushPublicKey,
            otel: props?.otel,
            storeId: props?.storeId,
            stripe: props?.stripe,
            zdr: props?.zdr,
          };
        });

      const mapGateway = (
        gateway:
          | aiGateway.GetAiGatewayResponse
          | aiGateway.CreateAiGatewayResponse
          | aiGateway.UpdateAiGatewayResponse,
        accountId: string,
      ): AiGateway["Attributes"] => ({
        gatewayId: gateway.id,
        accountId,
        accountTag: gateway.accountTag ?? undefined,
        internalId: gateway.internalId ?? undefined,
        cacheInvalidateOnUpdate: gateway.cacheInvalidateOnUpdate,
        cacheTtl: nullIfZero(gateway.cacheTtl),
        collectLogs: gateway.collectLogs,
        createdAt: gateway.createdAt,
        modifiedAt: gateway.modifiedAt,
        rateLimitingInterval: nullIfZero(gateway.rateLimitingInterval),
        rateLimitingLimit: nullIfZero(gateway.rateLimitingLimit),
        rateLimitingTechnique: gateway.rateLimitingTechnique ?? "fixed",
        authentication: gateway.authentication ?? undefined,
        dlp: gateway.dlp,
        isDefault: gateway.isDefault ?? undefined,
        logManagement: gateway.logManagement,
        logManagementStrategy: gateway.logManagementStrategy,
        logpush: gateway.logpush ?? undefined,
        logpushPublicKey: gateway.logpushPublicKey,
        otel: gateway.otel,
        storeId: gateway.storeId,
        stripe: gateway.stripe,
        zdr: gateway.zdr ?? undefined,
      });

      const mutable = (gateway: AiGateway["Attributes"]) => ({
        cacheInvalidateOnUpdate: gateway.cacheInvalidateOnUpdate,
        cacheTtl: gateway.cacheTtl,
        collectLogs: gateway.collectLogs,
        rateLimitingInterval: gateway.rateLimitingInterval,
        rateLimitingLimit: gateway.rateLimitingLimit,
        rateLimitingTechnique: gateway.rateLimitingTechnique,
        authentication: gateway.authentication,
        dlp: gateway.dlp ?? undefined,
        isDefault: gateway.isDefault,
        logManagement: gateway.logManagement,
        logManagementStrategy: gateway.logManagementStrategy,
        logpush: gateway.logpush,
        logpushPublicKey: gateway.logpushPublicKey,
        otel: gateway.otel,
        storeId: gateway.storeId,
        stripe: gateway.stripe,
        zdr: gateway.zdr,
      });

      const createRequest = Effect.fn(function* (
        id: string,
        props: AiGatewayProps | undefined,
      ) {
        const next = yield* desired(id, props);
        return {
          accountId,
          id: next.gatewayId,
          cacheInvalidateOnUpdate: next.cacheInvalidateOnUpdate,
          cacheTtl: next.cacheTtl,
          collectLogs: next.collectLogs,
          rateLimitingInterval: next.rateLimitingInterval,
          rateLimitingLimit: next.rateLimitingLimit,
          rateLimitingTechnique: next.rateLimitingTechnique,
          authentication: next.authentication,
          isDefault: next.isDefault,
          logManagement: next.logManagement,
          logManagementStrategy: next.logManagementStrategy,
          logpush: next.logpush,
          logpushPublicKey: next.logpushPublicKey,
          zdr: next.zdr,
        } satisfies aiGateway.CreateAiGatewayRequest;
      });

      const updateRequest = Effect.fn(function* (
        id: string,
        props: AiGatewayProps | undefined,
        accountId: string,
      ) {
        const next = yield* desired(id, props);
        return {
          accountId,
          id: next.gatewayId,
          cacheInvalidateOnUpdate: next.cacheInvalidateOnUpdate,
          cacheTtl: next.cacheTtl,
          collectLogs: next.collectLogs,
          rateLimitingInterval: next.rateLimitingInterval,
          rateLimitingLimit: next.rateLimitingLimit,
          rateLimitingTechnique: next.rateLimitingTechnique,
          authentication: next.authentication,
          dlp: next.dlp,
          isDefault: next.isDefault,
          logManagement: next.logManagement,
          logManagementStrategy: next.logManagementStrategy,
          logpush: next.logpush,
          logpushPublicKey: next.logpushPublicKey,
          otel: next.otel,
          storeId: next.storeId,
          stripe: next.stripe,
          zdr: next.zdr,
        } satisfies aiGateway.UpdateAiGatewayRequest;
      });

      return {
        stables: ["gatewayId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const next = yield* desired(id, news);
          const oldGatewayId =
            output?.gatewayId ?? (yield* createGatewayId(id, olds.id));
          if (
            (output?.accountId ?? accountId) !== accountId ||
            oldGatewayId !== next.gatewayId
          ) {
            return { action: "replace" } as const;
          }

          const oldMutable = output
            ? mutable(output)
            : yield* desired(id, olds).pipe(
                Effect.map((old) => ({
                  cacheInvalidateOnUpdate: old.cacheInvalidateOnUpdate,
                  cacheTtl: old.cacheTtl,
                  collectLogs: old.collectLogs,
                  rateLimitingInterval: old.rateLimitingInterval,
                  rateLimitingLimit: old.rateLimitingLimit,
                  rateLimitingTechnique: old.rateLimitingTechnique,
                  authentication: old.authentication,
                  dlp: old.dlp,
                  isDefault: old.isDefault,
                  logManagement: old.logManagement,
                  logManagementStrategy: old.logManagementStrategy,
                  logpush: old.logpush,
                  logpushPublicKey: old.logpushPublicKey,
                  otel: old.otel,
                  storeId: old.storeId,
                  stripe: old.stripe,
                  zdr: old.zdr,
                })),
              );
          const nextMutable = {
            cacheInvalidateOnUpdate: next.cacheInvalidateOnUpdate,
            cacheTtl: next.cacheTtl,
            collectLogs: next.collectLogs,
            rateLimitingInterval: next.rateLimitingInterval,
            rateLimitingLimit: next.rateLimitingLimit,
            rateLimitingTechnique: next.rateLimitingTechnique,
            authentication: next.authentication,
            dlp: next.dlp,
            isDefault: next.isDefault,
            logManagement: next.logManagement,
            logManagementStrategy: next.logManagementStrategy,
            logpush: next.logpush,
            logpushPublicKey: next.logpushPublicKey,
            otel: next.otel,
            storeId: next.storeId,
            stripe: next.stripe,
            zdr: next.zdr,
          };
          if (!deepEqual(oldMutable, nextMutable)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const acct = output?.accountId ?? accountId;
          const gatewayId =
            output?.gatewayId ?? (yield* createGatewayId(id, news.id));

          // Observe — fetch the gateway's current state. The Cloudflare API
          // returns 404 when the gateway is missing, which we tolerate so the
          // reconciler can fall through to create.
          const observed = yield* getAiGateway({
            accountId: acct,
            id: gatewayId,
          }).pipe(
            Effect.catchTag("GatewayNotFound", () => Effect.succeed(undefined)),
          );

          // Ensure — create if missing. Tolerate `GatewayAlreadyExists` for
          // idempotency: a peer reconciler may have created it concurrently,
          // or state persistence may have failed after a previous create.
          if (observed === undefined) {
            const request = yield* createRequest(id, news);
            yield* createAiGateway(request).pipe(
              Effect.catchTag("GatewayAlreadyExists", () =>
                getAiGateway({ accountId: acct, id: request.id }),
              ),
            );
          }

          // Sync — the Cloudflare AI Gateway update API is a full PATCH that
          // overwrites all mutable fields. We always apply the desired shape
          // so adoption, drift, and routine updates all converge.
          const update = yield* updateRequest(id, news, acct);
          const gateway = yield* updateAiGateway(update);
          return mapGateway(gateway, acct);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteAiGateway({
            accountId: output.accountId,
            id: output.gatewayId,
          }).pipe(Effect.catchTag("GatewayNotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const gatewayId =
            output?.gatewayId ?? (yield* createGatewayId(id, olds?.id));
          const acct = output?.accountId ?? accountId;
          return yield* getAiGateway({
            accountId: acct,
            id: gatewayId,
          }).pipe(
            Effect.map((gateway) => mapGateway(gateway, acct)),
            Effect.catchTag("GatewayNotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
