import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { findZoneByName } from "./lookup.ts";

export type ZoneType = "full" | "partial" | "secondary" | "internal";
export type ZoneStatus = "initializing" | "pending" | "active" | "moved";

/**
 * Common shape returned by a managed {@link Zone} resource — anything that
 * needs to point at a Cloudflare Zone can accept this.
 */
export type ZoneAttributes = {
  zoneId: string;
  name: string;
  accountId: string;
  type: ZoneType;
  status: ZoneStatus | undefined;
  paused: boolean;
  nameServers: string[];
  originalNameServers: string[] | undefined;
  vanityNameServers: string[] | undefined;
};

export type ZoneProps = {
  /**
   * The fully-qualified zone name (e.g. `example.com`). Stable — changing it
   * triggers a replacement.
   */
  name: string;
  /**
   * Zone type. Full zones host their own DNS at Cloudflare; partial zones are
   * partner/CNAME setups.
   * @default "full"
   */
  type?: ZoneType;
  /**
   * Pause Cloudflare's proxy on the zone (DNS-only).
   * @default false
   */
  paused?: boolean;
  /**
   * Custom (vanity) name servers. Business/Enterprise only.
   */
  vanityNameServers?: string[];
};

export type Zone = Resource<
  "Cloudflare.Zone",
  ZoneProps,
  ZoneAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zone (DNS domain) managed by Alchemy.
 *
 * Zones default to **retain** on removal — destroying the stack does NOT
 * delete the zone in Cloudflare. Opt in to actual deletion by wrapping the
 * resource (or the whole stack) in {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * @section Creating a Zone
 * @example Create a new zone
 * ```typescript
 * const zone = yield* Cloudflare.Zone("MyZone", {
 *   name: "example.com",
 * });
 * ```
 *
 * @example Allow destruction
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy";
 * yield* Cloudflare.Zone("MyZone", { name: "example.com" }).pipe(destroy());
 * ```
 *
 * @section Adopting an existing Zone
 * @example Take over a zone that already exists in Cloudflare
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 * // A zone carries no ownership markers, so the engine refuses to take over a
 * // pre-existing zone unless you opt in with `adopt(true)`.
 * const zone = yield* Cloudflare.Zone("MyZone", {
 *   name: "example.com",
 * }).pipe(adopt(true));
 * // zone.zoneId, zone.nameServers, zone.accountId, ...
 * ```
 */
export const Zone = Resource<Zone>("Cloudflare.Zone", {
  defaultRemovalPolicy: "retain",
});

export const ZoneProvider = () =>
  Provider.effect(
    Zone,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const get = yield* zones.getZone;
      const create = yield* zones.createZone;
      const patch = yield* zones.patchZone;
      const del = yield* zones.deleteZone;

      return {
        stables: ["name", "zoneId", "accountId"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!output) return undefined;
          if (!isResolved(news)) return undefined;
          if (news.name !== output.name) {
            return { action: "replace" } as const;
          }
          const desiredType = news.type ?? "full";
          const desiredPaused = news.paused ?? false;
          const desiredVanity = news.vanityNameServers ?? [];
          if (
            desiredType !== output.type ||
            desiredPaused !== output.paused ||
            !stringArrayEq(desiredVanity, output.vanityNameServers ?? [])
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const name = output?.name ?? olds?.name;
          // Owned path: we have persisted state (our own zoneId) — refresh it.
          if (output?.zoneId) {
            const result = yield* get({ zoneId: output.zoneId }).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (result) return toZoneAttributes(result, accountId);
          }
          // Adoption path: no state of our own, but a zone with this name
          // already exists in the cloud. Cloudflare zones carry no ownership
          // markers we can inspect, so we cannot prove we created it — brand
          // it `Unowned` so the engine refuses to take over unless `adopt` is
          // set.
          if (name) {
            const match = yield* findZoneByName({ accountId, name });
            if (!match) return undefined;
            const result = yield* get({ zoneId: match.id });
            return Unowned(toZoneAttributes(result, accountId));
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // 1. Observe — do we have a live zone for this name?
          let zoneId = output?.zoneId;
          if (!zoneId) {
            const match = yield* findZoneByName({
              accountId,
              name: news.name,
            });
            zoneId = match?.id;
          }

          // 2. Ensure — create if missing.
          if (!zoneId) {
            const created = yield* create({
              account: { id: accountId },
              name: news.name,
              type: news.type ?? "full",
            });
            zoneId = created.id;
          }

          // 3. Sync — apply mutable settings (type/paused/vanity NS).
          const observed = yield* get({ zoneId });
          const desiredType = news.type ?? "full";
          const desiredPaused = news.paused ?? false;
          const desiredVanity = news.vanityNameServers ?? [];
          const needsPatch =
            (observed.type ?? "full") !== desiredType ||
            (observed.paused ?? false) !== desiredPaused ||
            !stringArrayEq(observed.vanityNameServers ?? [], desiredVanity);

          if (needsPatch) {
            yield* patch({
              zoneId,
              type: desiredType,
              paused: desiredPaused,
              vanityNameServers: desiredVanity,
            });
          }

          const final = yield* get({ zoneId });
          return toZoneAttributes(final, accountId);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output.zoneId) return;
          yield* del({ zoneId: output.zoneId }).pipe(
            Effect.catch((error: unknown) => {
              // Zone already gone — idempotent delete.
              const status = (error as { status?: number }).status;
              if (status === 404) return Effect.void;
              return Effect.fail(error);
            }),
          );
        }),
      };
    }),
  );

/** @internal — shape a distilled zones API result into `ZoneAttributes`. */
export const toZoneAttributes = (
  result: {
    id: string;
    name: string;
    account: { id?: string | null };
    type?: ZoneType | null;
    status?: ZoneStatus | null;
    paused?: boolean | null;
    nameServers: ReadonlyArray<string>;
    originalNameServers?: ReadonlyArray<string> | null;
    vanityNameServers?: ReadonlyArray<string> | null;
  },
  fallbackAccountId: string,
): ZoneAttributes => ({
  zoneId: result.id,
  name: result.name,
  accountId: result.account.id ?? fallbackAccountId,
  type: (result.type ?? "full") as ZoneType,
  status: (result.status ?? undefined) as ZoneStatus | undefined,
  paused: result.paused ?? false,
  nameServers: [...result.nameServers],
  originalNameServers: result.originalNameServers
    ? [...result.originalNameServers]
    : undefined,
  vanityNameServers: result.vanityNameServers
    ? [...result.vanityNameServers]
    : undefined,
});

const stringArrayEq = Array.makeEquivalence(Equivalence.String);
