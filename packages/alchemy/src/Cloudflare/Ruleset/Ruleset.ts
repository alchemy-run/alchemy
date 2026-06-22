import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { Zone, ZoneAttributes } from "../Zone/index.ts";
import { listAllZones } from "../Zone/lookup.ts";

export type RulesetPhase = rulesets.CreateRulesetForZoneRequest["phase"];
export type RulesetRule = NonNullable<
  rulesets.PutPhasForZoneRequest["rules"]
>[number];
export type RulesetOutputRule = Omit<
  NonNullable<rulesets.GetPhasResponse["rules"]>[number],
  "lastUpdated" | "version"
>;

export type RulesetProps = {
  /**
   * Zone to apply the ruleset to. Pass a `Cloudflare.Zone`.
   */
  zone: Zone;
  /**
   * Ruleset phase entrypoint to own.
   */
  phase: RulesetPhase;
  /**
   * Rules to apply to the phase entrypoint.
   */
  rules: RulesetRule[];
  /**
   * Human-readable name for the ruleset.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Description for the ruleset.
   */
  description?: string;
};

export type RulesetKind =
  | "managed"
  | "custom"
  | "root"
  | "zone"
  | (string & {});

export type Ruleset = Resource<
  "Cloudflare.Ruleset",
  RulesetProps,
  {
    /** The unique ID of the ruleset (Cloudflare `id`). */
    rulesetId: string;
    /**
     * Zone the ruleset phase entrypoint belongs to. Alchemy-flattened
     * identifier — not part of Cloudflare's phase-entrypoint response.
     */
    zoneId: string;
    /** The kind of the ruleset. */
    kind: RulesetKind;
    /** The human-readable name of the ruleset. */
    name: string;
    /** The phase of the ruleset. */
    phase: RulesetPhase;
    /** An informative description of the ruleset. */
    description: string | undefined;
    /** The list of rules in the ruleset. */
    rules: RulesetOutputRule[];
    /** The timestamp of when the ruleset was last modified. */
    lastUpdated: string;
    /** The version of the ruleset. */
    version: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Ruleset phase entrypoint for a zone.
 *
 * This resource owns the entire ruleset for a phase entrypoint. Rules managed
 * elsewhere in the same phase can be overwritten on deploy.
 * @resource
 * @product Rulesets
 * @category Rules & Configuration
 * @section WAF Rules
 * @example Block probes in the custom firewall phase
 * ```typescript
 * const zone = yield* Cloudflare.Zone("MyZone", { name: "example.com" });
 * const waf = yield* Cloudflare.Ruleset("WafRules", {
 *   zone,
 *   phase: "http_request_firewall_custom",
 *   rules: [
 *     {
 *       description: "Block exploit probes",
 *       expression: `lower(http.request.uri.path) contains "/.env"`,
 *       action: "block",
 *     },
 *   ],
 * });
 * ```
 */
export const Ruleset = Resource<Ruleset>("Cloudflare.Ruleset")({});

export const RulesetProvider = () =>
  Provider.succeed(Ruleset, {
    stables: ["zoneId", "phase"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const desiredZoneId = zoneIdOf(news.zone);

      // The desired zone id may still be an unresolved Output (e.g. the
      // zone is being created in the same deploy). Only make a zone-change
      // replacement decision once we have a concrete id.
      if (desiredZoneId !== undefined) {
        if (output?.zoneId && desiredZoneId !== output.zoneId) {
          return { action: "replace" } as const;
        }
        const oldZoneId = olds.zone ? zoneIdOf(olds.zone) : undefined;
        if (oldZoneId !== undefined && oldZoneId !== desiredZoneId) {
          return { action: "replace" } as const;
        }
      }
      if (olds.phase !== news.phase) {
        return { action: "replace" } as const;
      }

      const oldName = output?.name ?? (yield* createRulesetName(id, olds.name));
      const name = yield* createRulesetName(id, news.name);
      if (
        oldName !== name ||
        olds.description !== news.description ||
        !deepEqual(olds.rules, news.rules)
      ) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const zoneId = output?.zoneId ?? zoneIdOf(news.zone);
      if (zoneId === undefined) {
        return yield* Effect.fail(
          new Error("Cloudflare Ruleset: zone id is not resolved"),
        );
      }
      const name = yield* createRulesetName(id, news.name ?? output?.name);
      const ruleset = yield* rulesets.putPhasForZone({
        zoneId,
        rulesetPhase: news.phase,
        name,
        description: news.description,
        rules: news.rules,
      });
      return toRulesetAttributes(zoneId, ruleset);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      yield* rulesets
        .putPhasForZone({
          zoneId: output.zoneId,
          rulesetPhase: olds.phase,
          name: output.name,
          description: output.description,
          rules: [],
        })
        .pipe(Effect.catchTag("RulesetNotFound", () => Effect.void));
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const zoneId = output?.zoneId ?? zoneIdOf(olds.zone);
      if (zoneId === undefined) return undefined;
      return yield* rulesets
        .getPhasForZone({
          zoneId,
          rulesetPhase: output?.phase ?? olds.phase,
        })
        .pipe(
          Effect.map((ruleset) => toRulesetAttributes(zoneId, ruleset)),
          Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)),
        );
    }),
    // A `Ruleset` is a zone phase entrypoint (kind: "zone"). There is no
    // account-wide enumeration for entrypoints, so fan out over every zone
    // via `listAllZones`, list that zone's rulesets, keep the entrypoints,
    // and hydrate each into the full Attributes shape (the list response
    // omits `rules`) via `getPhasForZone`.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          rulesets.listRulesetsForZone.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).filter((r) => r.kind === "zone"),
              ),
            ),
            Effect.flatMap((entrypoints) =>
              Effect.forEach(
                entrypoints,
                (entry) =>
                  rulesets
                    .getPhasForZone({
                      zoneId: zone.id,
                      rulesetPhase: entry.phase,
                    })
                    .pipe(
                      Effect.map((ruleset) =>
                        toRulesetAttributes(zone.id, ruleset),
                      ),
                      // Per-item not-found / plan-gated entrypoints are
                      // skipped rather than failing the whole enumeration.
                      Effect.catchTag(["RulesetNotFound", "Forbidden"], () =>
                        Effect.succeed(undefined),
                      ),
                    ),
                { concurrency: 10 },
              ),
            ),
            Effect.map((items) =>
              items.filter(
                (item): item is Ruleset["Attributes"] => item !== undefined,
              ),
            ),
            // Plan-gated / partially-provisioned zones reject the route.
            Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

const createRulesetName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

export const toRulesetAttributes = (
  zoneId: string,
  ruleset: rulesets.GetPhasResponse | rulesets.PutPhasResponse,
): Ruleset["Attributes"] => ({
  rulesetId: ruleset.id,
  zoneId,
  kind: ruleset.kind,
  name: ruleset.name,
  phase: ruleset.phase,
  description: ruleset.description ?? undefined,
  rules: (ruleset.rules ?? []).map(
    ({ lastUpdated: _lastUpdated, version: _version, ...rule }) => rule,
  ),
  lastUpdated: ruleset.lastUpdated,
  version: ruleset.version,
});

// A `Zone` prop is resolved to its attributes before a lifecycle op runs, so
// `zone.zoneId` is normally a plain string even though the `Zone` resource
// type statically exposes it as an `Output`. During `diff` (plan time) the
// zone can still be unresolved — e.g. when it's being created in the same
// deploy — in which case `zoneId` is not yet a string. Callers must treat a
// non-string result as "not resolved yet".
const zoneIdOf = (zone: Zone): string | undefined => {
  const zoneId = (zone as unknown as Partial<ZoneAttributes>).zoneId;
  return typeof zoneId === "string" ? zoneId : undefined;
};
