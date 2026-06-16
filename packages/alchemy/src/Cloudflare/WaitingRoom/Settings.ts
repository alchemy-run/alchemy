import * as waitingRooms from "@distilled.cloud/cloudflare/waiting-rooms";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const WaitingRoomSettingsTypeId = "Cloudflare.WaitingRoom.Settings" as const;
type WaitingRoomSettingsTypeId = typeof WaitingRoomSettingsTypeId;

export type WaitingRoomSettingsProps = {
  /**
   * Zone whose waiting room settings are managed. Stable — changing the
   * zone triggers a replacement (the old zone's settings are restored to
   * the value they had before Alchemy managed them).
   */
  zoneId: string;
  /**
   * Whether to allow verified search engine crawlers to bypass all waiting
   * rooms on this zone. Enabling the bypass requires the Waiting Room
   * Advanced subscription. Mutable.
   * @default false
   */
  searchEngineCrawlerBypass?: boolean;
};

export type WaitingRoomSettingsAttributes = {
  /** Zone the settings belong to. */
  zoneId: string;
  /** Whether verified search engine crawlers bypass all waiting rooms. */
  searchEngineCrawlerBypass: boolean;
  /**
   * The value the setting had before Alchemy first managed it. Restored on
   * destroy, so deleting the resource puts the zone back the way it was
   * found.
   */
  initialSearchEngineCrawlerBypass: boolean;
};

export type WaitingRoomSettings = Resource<
  WaitingRoomSettingsTypeId,
  WaitingRoomSettingsProps,
  WaitingRoomSettingsAttributes,
  never,
  Providers
>;

/**
 * Zone-wide Cloudflare Waiting Room settings
 * (`/zones/{zone_id}/waiting_rooms/settings`).
 *
 * The settings object is a zone singleton — it always exists with
 * Cloudflare defaults, so this resource never creates or deletes anything
 * physical. Reconcile PUTs the settings when the observed value differs
 * from the desired one; destroy restores the value the zone had before
 * Alchemy first managed it.
 *
 * Writes are plan-gated: on zones without a Waiting Rooms entitlement
 * (Business/Enterprise) every PUT fails with the typed `ZoneNotEntitled`
 * error (Cloudflare code 1034). Reads work on every plan, and a no-op
 * reconcile (desired equals observed) skips the API call entirely.
 *
 * @section Managing settings
 * @example Let search engine crawlers bypass waiting rooms
 * ```typescript
 * yield* Cloudflare.WaitingRoomSettings("CrawlerBypass", {
 *   zoneId: zone.zoneId,
 *   searchEngineCrawlerBypass: true,
 * });
 * ```
 *
 * @example Pin the settings to their defaults
 * ```typescript
 * yield* Cloudflare.WaitingRoomSettings("Defaults", {
 *   zoneId: zone.zoneId,
 *   searchEngineCrawlerBypass: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waiting-room/
 */
export const WaitingRoomSettings = Resource<WaitingRoomSettings>(
  WaitingRoomSettingsTypeId,
);

/**
 * Returns true if the given value is a WaitingRoomSettings resource.
 */
export const isWaitingRoomSettings = (
  value: unknown,
): value is WaitingRoomSettings =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === WaitingRoomSettingsTypeId;

export const WaitingRoomSettingsProvider = () =>
  Provider.succeed(WaitingRoomSettings, {
    nuke: { singleton: true },
    stables: ["zoneId", "initialSearchEngineCrawlerBypass"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its settings (every zone has one).
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          waitingRooms.getSetting({ zoneId }).pipe(
            Effect.map((observed) =>
              toAttributes(
                zoneId,
                observed.searchEngineCrawlerBypass,
                observed.searchEngineCrawlerBypass,
              ),
            ),
            // Plan-gated or partial zones reject the route; skip them.
            Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is WaitingRoomSettingsAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as WaitingRoomSettingsProps;
      const n = news as WaitingRoomSettingsProps;
      // zoneId is Input<string>; compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* waitingRooms.getSetting({ zoneId }).pipe(
        // Zone deleted out-of-band — the settings are gone with it.
        Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      // The settings singleton always exists with a Cloudflare default —
      // there is nothing to "own", so a cold read adopts freely. The
      // observed value at adoption time becomes the initial value restored
      // on destroy.
      const initial =
        output !== undefined
          ? output.initialSearchEngineCrawlerBypass
          : observed.searchEngineCrawlerBypass;
      return toAttributes(zoneId, observed.searchEngineCrawlerBypass, initial);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the settings singleton always exists.
      const observed = yield* waitingRooms.getSetting({ zoneId });

      // 2. Capture — the pre-management value, restored on destroy.
      const initial =
        output !== undefined
          ? output.initialSearchEngineCrawlerBypass
          : observed.searchEngineCrawlerBypass;

      // 3. Sync — PUT only when the observed value differs.
      const desired = news.searchEngineCrawlerBypass ?? false;
      if (observed.searchEngineCrawlerBypass === desired) {
        return toAttributes(
          zoneId,
          observed.searchEngineCrawlerBypass,
          initial,
        );
      }
      const updated = yield* waitingRooms.putSetting({
        zoneId,
        searchEngineCrawlerBypass: desired,
      });
      return toAttributes(zoneId, updated.searchEngineCrawlerBypass, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialSearchEngineCrawlerBypass } = output;
      // Observe — if the zone itself is gone, so are the settings.
      const observed = yield* waitingRooms
        .getSetting({ zoneId })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)));
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (
        observed.searchEngineCrawlerBypass === initialSearchEngineCrawlerBypass
      ) {
        return;
      }
      yield* waitingRooms
        .putSetting({
          zoneId,
          searchEngineCrawlerBypass: initialSearchEngineCrawlerBypass,
        })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

const toAttributes = (
  zoneId: string,
  searchEngineCrawlerBypass: boolean,
  initialSearchEngineCrawlerBypass: boolean,
): WaitingRoomSettingsAttributes => ({
  zoneId,
  searchEngineCrawlerBypass,
  initialSearchEngineCrawlerBypass,
});
