import * as DO from "@distilled.cloud/digitalocean";
import type { Check } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { setEquals } from "../internal/equal.ts";
import { ignoreNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type UptimeCheckType = "ping" | "http" | "https";
export type UptimeCheckRegion = "us_east" | "us_west" | "eu_west" | "se_asia";

export type UptimeCheckProps = {
  /**
   * Display name. A change renames the check in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** How to probe the target. */
  type: UptimeCheckType;
  /** URL for `http`/`https`, host name or IP for `ping`. */
  target: string;
  /**
   * Regions to probe from.
   *
   * @default ["us_east", "us_west", "eu_west", "se_asia"]
   */
  regions?: UptimeCheckRegion[];
  /**
   * Run the check.
   *
   * @default true
   */
  enabled?: boolean;
};

export type UptimeCheck = Resource<
  "DigitalOcean.Monitoring.UptimeCheck",
  UptimeCheckProps,
  {
    /** Check id (UUID). */
    checkId: string;
    /** Display name. */
    name: string;
    /** How the target is probed. */
    type: string;
    /** The probed target. */
    target: string;
    /** Regions the check probes from. */
    regions: string[];
    /** Whether the check runs. */
    enabled: boolean;
  },
  never,
  Providers
>;

export type UptimeCheckAttributes = UptimeCheck["Attributes"];

/**
 * A DigitalOcean uptime check: probes a URL or host from up to four
 * regions every minute. Add `UptimeAlert`s to be told when it goes down,
 * slows down, or its certificate is about to expire. Every prop updates in
 * place.
 *
 * Alchemy owns a check whose name it generated or whose id it recorded; a
 * check that already has the chosen name is `Unowned` and needs `--adopt`.
 *
 * ### Probing a Site
 * **Example:** An HTTPS check with a downtime alert
 * ```typescript
 * const check = yield* DigitalOcean.Monitoring.UptimeCheck("site", {
 *   type: "https",
 *   target: "https://example.com/health",
 * });
 * yield* DigitalOcean.Monitoring.UptimeAlert("site-down", {
 *   checkId: check.checkId,
 *   type: "down",
 *   period: "2m",
 *   notifications: { email: ["oncall@example.com"] },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Uptime
 *
 * @resource
 * @product Monitoring
 * @category Observability
 */
export const UptimeCheck = Resource<UptimeCheck>("DigitalOcean.Monitoring.UptimeCheck");

const ALL_REGIONS: UptimeCheckRegion[] = ["us_east", "us_west", "eu_west", "se_asia"];

const PAGE_SIZE = 200;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 100 });

const toAttrs = (check: Check): UptimeCheckAttributes => ({
  checkId: check.id,
  name: check.name,
  type: check.type,
  target: check.target,
  regions: [...check.regions],
  enabled: check.enabled,
});

// The uptime API answers a missing id with 403, typed as UptimeCheckNotFound.
const observeById = (checkId: string) =>
  DO.getUptimeCheck({ check_id: checkId }).pipe(
    Effect.map((r) => Option.some(r.check)),
    Effect.catchTag(["NotFound", "UptimeCheckNotFound"], () => Effect.succeedNone),
  );

const observeByName = (name: string) =>
  DO.listUptimeChecks.items({ per_page: PAGE_SIZE }).pipe(
    Stream.filter((check) => check.name === name),
    Stream.runHead,
  );

const observeOwned = Effect.fn(function* (
  checkId: string | undefined,
  generatedName: string | undefined,
) {
  if (checkId !== undefined) {
    const byId = yield* observeById(checkId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<Check>();
  return yield* observeByName(generatedName);
});

export const UptimeCheckProvider = () =>
  Provider.succeed(UptimeCheck, {
    stables: ["checkId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const owned = yield* observeOwned(output?.checkId, generatedName);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      return named.pipe(
        Option.map((check) =>
          check.id === previous?.checkId ? toAttrs(check) : Unowned(toAttrs(check)),
        ),
        Option.getOrUndefined,
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;
      const desired = {
        name,
        type: news.type,
        target: news.target,
        regions: news.regions ?? ALL_REGIONS,
        enabled: news.enabled ?? true,
      };
      const observed = yield* observeOwned(output?.checkId, generatedName);
      if (Option.isNone(observed)) {
        const { check } = yield* DO.createUptimeCheck(desired);
        return toAttrs(check);
      }
      const check = observed.value;
      const inSync =
        check.name === desired.name &&
        check.type === desired.type &&
        check.target === desired.target &&
        check.enabled === desired.enabled &&
        setEquals(check.regions, desired.regions);
      if (inSync) return toAttrs(check);
      const updated = yield* DO.updateUptimeCheck({ check_id: check.id, ...desired });
      return toAttrs(updated.check);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteUptimeCheck({ check_id: output.checkId })).pipe(
        Effect.catchTag("UptimeCheckNotFound", () => Effect.void),
      );
    }),
  });
