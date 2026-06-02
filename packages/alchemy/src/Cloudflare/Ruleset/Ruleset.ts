import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Zone, ZoneAttributes } from "../Zone/index.ts";

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
 *
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

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("status" in error && (error as { status: unknown }).status === 404) ||
    ("_tag" in error && (error as { _tag: unknown })._tag === "NotFound"));

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

export const RulesetProvider = () =>
  Provider.effect(
    Ruleset,
    Effect.gen(function* () {
      const getPhas = yield* rulesets.getPhasForZone;
      const putPhas = yield* rulesets.putPhasForZone;

      const createRulesetName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      return {
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

          const oldName =
            output?.name ?? (yield* createRulesetName(id, olds.name));
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
          const ruleset = yield* putPhas({
            zoneId,
            rulesetPhase: news.phase,
            name,
            description: news.description,
            rules: news.rules,
          });
          return toRulesetAttributes(zoneId, ruleset);
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* putPhas({
            zoneId: output.zoneId,
            rulesetPhase: olds.phase,
            name: output.name,
            description: output.description,
            rules: [],
          }).pipe(Effect.catchIf(isNotFoundError, () => Effect.void));
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const zoneId = output?.zoneId ?? zoneIdOf(olds.zone);
          if (zoneId === undefined) return undefined;
          return yield* getPhas({
            zoneId,
            rulesetPhase: output?.phase ?? olds.phase,
          }).pipe(
            Effect.map((ruleset) => toRulesetAttributes(zoneId, ruleset)),
            Effect.catchIf(isNotFoundError, () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

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
