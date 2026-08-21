import { Services } from "@distilled.cloud/fly-io";
import type {
  AddOnPlansResponseEdgesItemNode,
  AddOnsResponseEdgesItemNode,
  CreateAddOnResponseAddOn,
} from "@distilled.cloud/fly-io/addons";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import * as Binding from "../Binding.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { resolveOrgSlug } from "./Environment.ts";
import {
  createFlyAppName,
  matchesAlchemyPhysicalName,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";

export const DEFAULT_REDIS_REGION = "iad";
export const REDIS_ADDON_TYPE = "upstash_redis";
export const REDIS_PROVIDER = "upstash_redis";
export const REDIS_URL_ENV = "REDIS_URL";

export interface RedisProps {
  /**
   * Upstash Redis database name. Globally unique in the org. If omitted,
   * a unique name is generated from the stack, stage and logical ID.
   * Changing it replaces the database.
   */
  name?: string;
  /**
   * Primary region (`iad`, `ord`, `sjc`, …). Fly cannot move a primary.
   * Changing it replaces the database.
   *
   * @default "iad"
   */
  primaryRegion?: string;
  /**
   * Organization slug. Defaults to the current token's org. Changing it
   * replaces the database.
   */
  orgSlug?: string;
  /**
   * Add-on plan id, name, or display name from `addOnPlans`. Default is
   * the cheapest listed plan (free or pay-as-you-go). Fixed plans are
   * billed — gate those tests with `FLY_TEST_REDIS_FIXED=1`.
   */
  plan?: string;
  /**
   * Read-replica regions. Updated in place. Must not include the
   * primary region.
   */
  readRegions?: string[];
  /**
   * Evict keys when memory is full (cache workload). Updated in place.
   */
  eviction?: boolean;
  /**
   * Automatically upgrade a fixed plan when hitting resource limits.
   * Ignored on pay-as-you-go.
   */
  autoUpgrade?: boolean;
  /**
   * ProdPack add-on ($200/mo). Paid. Not enabled in default tests.
   */
  prodPack?: boolean;
}

export type Redis = Resource<
  "Fly.Redis",
  RedisProps,
  {
    /** Fly GraphQL add-on id. */
    redisId: string;
    /** Physical Upstash Redis name. */
    name: string;
    /** Primary region code. */
    primaryRegion: string;
    /** Observed read-replica regions. */
    readRegions: string[];
    /** Observed status (`ready`, `provisioning`, …). */
    status: string | undefined;
    /** Selected plan id, if the API returned one. */
    planId: string | undefined;
    /** Observed plan name (`Pay-as-you-go`, `Fixed 250MB`, …). */
    planName: string | undefined;
    /** Private 6PN address, if the API returned one. */
    privateIp: string | undefined;
    /** Organization slug. */
    orgSlug: string | undefined;
    /** Whether eviction is enabled. */
    eviction: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * Managed Upstash Redis in a Fly org. Create the database, then
 * {@link Attach} it on a {@link Service} so Fly writes `REDIS_URL` as an
 * App secret. Redis is not reachable from CI — ping it from the Service.
 *
 * @resource
 * @see https://fly.io/docs/upstash/redis/
 *
 * @section Create Redis
 * Alchemy generates a unique name unless you pass one. Default region is
 * `iad`. Default plan is the cheapest `addOnPlans` row (free or
 * pay-as-you-go).
 *
 * @example Generated name
 * ```typescript
 * const cache = yield* Fly.Redis("Cache");
 * ```
 *
 * :::note
 * Prefer omitting `name` in tests and CI so names stay unique and
 * reclaimable.
 * :::
 *
 * @section A stable name
 * Pass `name` when you want a stable Upstash database name.
 *
 * @example Explicit name
 * ```typescript
 * const cache = yield* Fly.Redis("Cache", {
 *   name: "my-cache",
 *   primaryRegion: "iad",
 * });
 * ```
 *
 * :::caution[Changing `name` replaces Redis]
 * Fly cannot rename an add-on. Alchemy deletes the old database first,
 * then creates the new one.
 * :::
 *
 * :::caution[Changing `primaryRegion` replaces Redis]
 * The primary region is immutable. The old database is deleted first
 * because the name cannot exist twice.
 * :::
 *
 * @section Attach to a Service
 * Yield {@link Attach} in Service init. Provide {@link AttachLive}.
 * Alchemy writes `REDIS_URL` as an App secret. Read it at runtime with
 * `Config.redacted("REDIS_URL")`.
 *
 * @example Attach
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as Redacted from "effect/Redacted";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const Cache = Fly.Redis("Cache");
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     yield* Fly.Attach(Cache);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const redisUrl = yield* Config.redacted("REDIS_URL");
 *         return HttpServerResponse.text(
 *           Redacted.value(redisUrl) ? "ok" : "missing",
 *         );
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.AttachLive)),
 * ) {}
 * ```
 *
 * :::note
 * `Config.redacted("REDIS_URL")` in init reads the deployer's `.env`.
 * For a Fly-owned vault value, Attach the database and read
 * `REDIS_URL` from `fetch`.
 * :::
 *
 * @section Eviction
 * Enable eviction for cache workloads. Updated in place.
 *
 * @example Eviction
 * ```typescript
 * const cache = yield* Fly.Redis("Cache", {
 *   eviction: true,
 * });
 * ```
 *
 * @section Read replicas
 * `readRegions` are extra replica regions. Updated in place.
 *
 * @example Replica region
 * ```typescript
 * const cache = yield* Fly.Redis("Cache", {
 *   primaryRegion: "iad",
 *   readRegions: ["sjc"],
 * });
 * ```
 *
 * @section Plan
 * Omit `plan` for the cheapest listed plan. Pass a plan id or display
 * name to pin one. Fixed plans are billed.
 *
 * @example Pin pay-as-you-go
 * ```typescript
 * const cache = yield* Fly.Redis("Cache", {
 *   plan: "Pay-as-you-go",
 * });
 * ```
 *
 * :::caution[Fixed plans are billed]
 * Gate live tests of fixed plans with `FLY_TEST_REDIS_FIXED=1`.
 * :::
 */
export const Redis = Resource<Redis>("Fly.Redis");

export class RedisNotCreated extends Data.TaggedError("Fly.RedisNotCreated")<{
  name: string;
  errorMessage?: string;
}> {}

export class RedisPlanNotFound extends Data.TaggedError(
  "Fly.RedisPlanNotFound",
)<{
  plan: string;
}> {}

export class RedisOrgMissing extends Data.TaggedError("Fly.RedisOrgMissing")<{
  orgSlug: string;
}> {}

class RedisPending extends Data.TaggedError("Fly.RedisPending")<{
  redisId: string;
  status: string;
}> {}

type ObservedRedis = AddOnsResponseEdgesItemNode | CreateAddOnResponseAddOn;

type RedisPlan = AddOnPlansResponseEdgesItemNode;

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | null | undefined,
): string | undefined => {
  if (value == null) return undefined;
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
};

const recordOf = (value: unknown): Record<string, unknown> => {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
};

const stringRecordOf = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(recordOf(value)).flatMap(([key, item]) =>
      typeof item === "string" && item.length > 0 ? [[key, item]] : [],
    ),
  );

const evictionOf = (options: unknown): boolean | undefined => {
  const value = recordOf(options).eviction;
  return typeof value === "boolean" ? value : undefined;
};

const sorted = (regions: readonly string[] | null | undefined): string[] =>
  [...(regions ?? [])].sort();

const pendingStatus = (status: string | null | undefined): boolean => {
  if (status == null || status.length === 0) return false;
  const value = status.toLowerCase();
  return (
    value === "pending" ||
    value === "provisioning" ||
    value === "creating" ||
    value === "launching"
  );
};

const failedStatus = (status: string | null | undefined): boolean => {
  if (status == null) return false;
  const value = status.toLowerCase();
  return value === "error" || value === "failed" || value === "destroyed";
};

const isLegacyPlanName = (plan: RedisPlan): boolean => {
  const normalized = (plan.displayName ?? plan.name ?? "")
    .toLowerCase()
    .replaceAll(" ", "_");
  return (
    normalized === "pro_2k" ||
    normalized === "pro_10k" ||
    normalized === "starter" ||
    normalized === "standard"
  );
};

export const isFixedRedisPlan = (
  plan: Pick<RedisPlan, "name" | "displayName">,
): boolean => {
  const display = (plan.displayName ?? "").toLowerCase();
  const name = (plan.name ?? "").toLowerCase();
  return display.startsWith("fixed ") || name.startsWith("flyio_fixed_");
};

const hasAlchemyMetadata = (metadata: unknown): boolean => {
  const tags = stringRecordOf(metadata);
  const stack = tags["alchemy::stack"] ?? tags["alchemy.stack"];
  return stack !== undefined && stack.length > 0;
};

const isOwnedRedis = (row: ObservedRedis): boolean =>
  matchesAlchemyPhysicalName(row.name ?? undefined) ||
  hasAlchemyMetadata(row.metadata);

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyAppName(id);
  });

const toAttrs = (
  row: ObservedRedis,
  fallback: {
    name: string;
    primaryRegion: string;
    orgSlug?: string;
    planId?: string;
  },
): Redis["Attributes"] => ({
  redisId: row.id,
  name: row.name ?? fallback.name,
  primaryRegion: row.primaryRegion ?? fallback.primaryRegion,
  readRegions: sorted(row.readRegions),
  status: row.status ?? undefined,
  planId:
    "addOnPlan" in row
      ? ((row.addOnPlan as { id?: string } | null | undefined)?.id ??
        fallback.planId)
      : fallback.planId,
  planName: row.addOnPlanName ?? undefined,
  privateIp: row.privateIp ?? undefined,
  orgSlug:
    "organization" in row
      ? ((row.organization as { slug?: string | null } | undefined)?.slug ??
        fallback.orgSlug)
      : fallback.orgSlug,
  eviction: evictionOf(row.options),
});

export const listRedisAddOns = Effect.fn(function* () {
  const rows: AddOnsResponseEdgesItemNode[] = [];
  let after: string | undefined;
  for (let i = 0; i < 8; i++) {
    const page = yield* Services.addons.addOns({
      type: REDIS_ADDON_TYPE,
      first: 50,
      after,
    });
    for (const edge of page.edges ?? []) {
      if (edge?.node != null) rows.push(edge.node);
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor ?? undefined;
    if (after === undefined || after.length === 0) break;
  }
  return rows;
});

export const listRedisPlans = Effect.fn(function* () {
  const rows: RedisPlan[] = [];
  let after: string | undefined;
  for (let i = 0; i < 4; i++) {
    const page = yield* Services.addons.addOnPlans({
      type: REDIS_ADDON_TYPE,
      first: 50,
      after,
    });
    for (const edge of page.edges ?? []) {
      if (edge?.node != null) rows.push(edge.node);
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor ?? undefined;
    if (after === undefined || after.length === 0) break;
  }
  return rows;
});

export const findRedisAddOn = (input: { id?: string; name?: string }) =>
  listRedisAddOns().pipe(
    Effect.map((rows) =>
      rows.find((row) => {
        if (input.id !== undefined && row.id === input.id) return true;
        if (input.name !== undefined && row.name === input.name) return true;
        return false;
      }),
    ),
  );

const cheapestPlan = (plans: RedisPlan[]) => {
  const usable = plans.filter((plan) => !isLegacyPlanName(plan));
  const pool = usable.length > 0 ? usable : plans;
  if (pool.length === 0) return undefined;
  const free = pool.filter((plan) => (plan.pricePerMonth ?? 0) === 0);
  const ranked = (free.length > 0 ? free : pool).slice().sort((left, right) => {
    const byPrice = (left.pricePerMonth ?? 0) - (right.pricePerMonth ?? 0);
    if (byPrice !== 0) return byPrice;
    return (left.displayName ?? left.name ?? "").localeCompare(
      right.displayName ?? right.name ?? "",
    );
  });
  const payg = ranked.find((plan) =>
    /pay.?as.?you.?go|free/i.test(
      `${plan.displayName ?? ""} ${plan.name ?? ""}`,
    ),
  );
  return payg ?? ranked[0];
};

const resolvePlan = (
  plan: string | undefined,
  existingId: string | undefined,
) =>
  Effect.gen(function* () {
    const plans = yield* listRedisPlans();
    if (plan !== undefined) {
      const found = plans.find(
        (item) =>
          item.id === plan || item.name === plan || item.displayName === plan,
      );
      if (found === undefined) {
        return yield* new RedisPlanNotFound({ plan });
      }
      return found;
    }
    if (existingId !== undefined) {
      const existing = plans.find((item) => item.id === existingId);
      if (existing !== undefined) return existing;
    }
    const cheapest = cheapestPlan(plans);
    if (cheapest === undefined) {
      return yield* new RedisPlanNotFound({ plan: "default" });
    }
    return cheapest;
  });

const resolveOrganization = (orgSlug: string) =>
  Services.addons
    .organization({ slug: orgSlug })
    .pipe(Effect.catchTag("FlyIoParseError", () => Effect.succeed(undefined)));

const ensureTos = (orgSlug: string, organizationId: string) =>
  Effect.gen(function* () {
    const agreed = yield* Services.addons.agreedToProviderTos({
      slug: orgSlug,
      providerName: REDIS_PROVIDER,
    });
    if (agreed === true) return;
    // Tokens without org-admin cannot write the ToS row. Create still
    // succeeds when the org already agreed via flyctl.
    yield* Effect.result(
      Services.addons.createExtensionTosAgreement({
        input: {
          addOnProviderName: REDIS_PROVIDER,
          organizationId,
        },
      }),
    );
  });

const waitUntilReady = (id: string, name: string) =>
  findRedisAddOn({ id, name }).pipe(
    Effect.flatMap((row) => {
      if (row === undefined) {
        return Effect.fail(
          new RedisPending({ redisId: id, status: "missing" }),
        );
      }
      if (failedStatus(row.status)) {
        return Effect.fail(
          new RedisNotCreated({
            name: row.name ?? name,
            errorMessage: row.errorMessage ?? row.status ?? undefined,
          }),
        );
      }
      if (pendingStatus(row.status)) {
        return Effect.fail(
          new RedisPending({
            redisId: id,
            status: row.status ?? "provisioning",
          }),
        );
      }
      return Effect.succeed(row);
    }),
    Effect.retry({
      while: (error) => error._tag === "Fly.RedisPending",
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.RedisPending", () => findRedisAddOn({ id, name })),
  );

const waitUntilGone = (id: string, name: string) =>
  findRedisAddOn({ id, name }).pipe(
    Effect.map((row) => row === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const desiredOptions = (
  props: RedisProps,
  plan: RedisPlan,
  observed: unknown | undefined,
): Record<string, unknown> => {
  const options = recordOf(observed);
  if (props.eviction !== undefined) options.eviction = props.eviction;
  if (isFixedRedisPlan(plan)) {
    if (props.autoUpgrade !== undefined) {
      options.auto_upgrade = props.autoUpgrade;
    }
  } else {
    delete options.auto_upgrade;
  }
  delete options.prod_pack;
  return options;
};

/**
 * Write `REDIS_URL` onto an App from attached Redis add-on names.
 * Called from {@link Service} reconcile so the secret exists before
 * Machines boot.
 */
export const attachRedisSecrets = Effect.fn(function* (
  appName: string,
  attached: readonly { name: string }[],
) {
  if (appName.length === 0 || attached.length === 0) return;
  for (const item of attached) {
    const name = item.name;
    if (name.length === 0) continue;
    const row = yield* findRedisAddOn({ name });
    let url = unwrapSensitive(row?.publicUrl);
    if ((url === undefined || url.length === 0) && row?.id !== undefined) {
      const detail = yield* Services.addons
        .addOn({ id: row.id })
        .pipe(
          Effect.catchTag("FlyIoParseError", () => Effect.succeed(undefined)),
        );
      url = unwrapSensitive(detail?.publicUrl);
    }
    if (url === undefined || url.length === 0) continue;
    const updated = yield* Effect.result(
      Services.machines.secretsUpdate({
        app_name: appName,
        values: { [REDIS_URL_ENV]: url },
      }),
    );
    if (Result.isFailure(updated)) {
      yield* Services.machines
        .secretCreate({
          app_name: appName,
          secret_name: REDIS_URL_ENV,
          value: url,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
    }
  }
});

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

/**
 * Runtime view of an attached Redis database: the env-var Fly injects.
 */
export interface AttachedRedis {
  /** Env-var name. Read with `Config.redacted("REDIS_URL")`. */
  env: typeof REDIS_URL_ENV;
}

/**
 * Attach Upstash Redis to a {@link Service}. Writes `REDIS_URL` as an
 * App secret. Provide {@link AttachLive}.
 *
 * @binding
 *
 * @section Attach Redis
 * Yield `Attach` in init. Read `REDIS_URL` from `fetch`. Redis is not
 * reachable from CI.
 *
 * @example Bind REDIS_URL
 * ```typescript
 * import * as Config from "effect/Config";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     yield* Fly.Attach(Cache);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const redisUrl = yield* Config.redacted("REDIS_URL");
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.AttachLive)),
 * ) {}
 * ```
 */
export interface Attach extends Binding.Service<
  Attach,
  "Fly.Redis.Attach",
  (redis: Redis) => Effect.Effect<AttachedRedis>
> {}

export const Attach = Binding.Service<Attach>("Fly.Redis.Attach");

/**
 * Implementation layer for {@link Attach}. Provide it on the Service
 * Effect.
 *
 * @layer
 * @provides Fly.Redis.Attach
 */
export const AttachLive = Layer.effect(
  Attach,
  Effect.succeed(
    Effect.fn(function* (redis: Redis) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${redis}`({
            redis: { name: redis.name },
          });
        }
      }
      return { env: REDIS_URL_ENV };
    }),
  ),
);

export const RedisProvider = () =>
  Provider.succeed(Redis, {
    stables: ["redisId", "name", "primaryRegion", "orgSlug"],

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName =
        news.name !== undefined ? sanitizeFlyAppName(news.name) : output.name;
      const nameChanged = desiredName !== output.name;
      const desiredRegion = news.primaryRegion ?? DEFAULT_REDIS_REGION;
      const regionChanged = desiredRegion !== output.primaryRegion;
      const orgChanged =
        news.orgSlug !== undefined && news.orgSlug !== output.orgSlug;
      if (nameChanged || regionChanged || orgChanged) {
        return {
          action: "replace" as const,
          deleteFirst: !nameChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* resolveName(id, olds?.name, output?.name);
      const found =
        (output?.redisId !== undefined
          ? yield* findRedisAddOn({ id: output.redisId, name: output.name })
          : undefined) ?? (yield* findRedisAddOn({ name }));
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, {
        name,
        primaryRegion: olds?.primaryRegion ?? DEFAULT_REDIS_REGION,
        orgSlug: olds?.orgSlug ?? output?.orgSlug,
      });
      if (output !== undefined) return attrs;
      return isOwnedRedis(found) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const rows = yield* listRedisAddOns();
      return rows.flatMap((row) => {
        if (!isOwnedRedis(row)) return [];
        const name = row.name;
        if (name == null || name.length === 0) return [];
        return [
          toAttrs(row, {
            name,
            primaryRegion: row.primaryRegion ?? DEFAULT_REDIS_REGION,
          }),
        ];
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? {};
      const name = yield* resolveName(id, props.name, output?.name);
      const primaryRegion =
        props.primaryRegion ?? output?.primaryRegion ?? DEFAULT_REDIS_REGION;
      const orgSlug = props.orgSlug ?? (yield* resolveOrgSlug());
      const org = yield* resolveOrganization(orgSlug);
      if (org === undefined) {
        return yield* new RedisOrgMissing({ orgSlug });
      }

      let current =
        output?.redisId !== undefined
          ? yield* findRedisAddOn({
              id: output.redisId,
              name: output.name,
            })
          : undefined;
      if (
        current === undefined &&
        (output === undefined || output.name !== name)
      ) {
        current = yield* findRedisAddOn({ name });
      }

      const plan = yield* resolvePlan(
        props.plan,
        current !== undefined && "addOnPlan" in current
          ? current.addOnPlan?.id
          : output?.planId,
      );

      if (current === undefined) {
        yield* ensureTos(orgSlug, org.id);
        const created = yield* Effect.result(
          Services.addons.createAddOn({
            input: {
              type: REDIS_ADDON_TYPE,
              name,
              organizationId: org.id,
              planId: plan.id,
              primaryRegion,
              readRegions: props.readRegions ?? [],
              options: desiredOptions(props, plan, undefined),
            },
          }),
        );
        if (Result.isSuccess(created)) {
          current = created.success.addOn;
        } else {
          current = yield* findRedisAddOn({ name });
          if (current === undefined) {
            return yield* Effect.fail(created.failure);
          }
        }
      }

      if (current === undefined) {
        return yield* new RedisNotCreated({ name });
      }

      if (pendingStatus(current.status)) {
        const ready = yield* waitUntilReady(current.id, name);
        if (ready !== undefined) current = ready;
      }

      if (current === undefined) {
        return yield* new RedisNotCreated({ name });
      }

      const observedOptions = recordOf(current.options);
      const nextOptions = desiredOptions(props, plan, current.options);
      const nextReadRegions = sorted(
        props.readRegions ?? current.readRegions ?? [],
      );
      const observedReadRegions = sorted(current.readRegions);
      const observedPlanId =
        "addOnPlan" in current ? current.addOnPlan?.id : output?.planId;
      const planChanged =
        observedPlanId !== undefined && observedPlanId !== plan.id;
      const regionsChanged = !deepEqual(observedReadRegions, nextReadRegions);
      const optionsChanged = !deepEqual(observedOptions, nextOptions);
      const prodPackChanged = props.prodPack !== undefined && planChanged;

      if (planChanged || regionsChanged || optionsChanged || prodPackChanged) {
        const updated = yield* Effect.result(
          Services.addons.updateAddOn({
            input: {
              addOnId: current.id,
              planId: plan.id,
              readRegions: nextReadRegions,
              options: nextOptions,
              prodPack: prodPackChanged ? props.prodPack : undefined,
            },
          }),
        );
        if (Result.isSuccess(updated)) {
          current = {
            ...current,
            ...updated.success.addOn,
          };
        } else {
          const refreshed = yield* findRedisAddOn({
            id: current.id,
            name,
          });
          if (refreshed !== undefined) current = refreshed;
        }
      }

      const latest =
        (yield* findRedisAddOn({ id: current.id, name })) ?? current;
      return toAttrs(latest, {
        name,
        primaryRegion,
        orgSlug,
        planId: plan.id,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const redisId = output.redisId;
      const name = output.name;
      if (redisId.length === 0 && (name === undefined || name.length === 0)) {
        return;
      }
      const deleted = yield* Effect.result(
        Services.addons.deleteAddOn({
          input:
            redisId.length > 0
              ? { addOnId: redisId }
              : { name, provider: REDIS_PROVIDER },
        }),
      );
      if (Result.isFailure(deleted)) {
        const still = yield* findRedisAddOn({ id: redisId, name });
        if (still !== undefined) {
          return yield* Effect.fail(deleted.failure);
        }
        return;
      }
      yield* waitUntilGone(redisId, name);
    }),
  });
