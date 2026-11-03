import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Stream from "effect/Stream";

export class ZoneLookupInvalidProps extends Data.TaggedError("ZoneLookupInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Reference to an existing Cloudflare Zone. Accepts:
 *   - a zone id (32 hex characters),
 *   - a zone name (`example.com`), or
 *   - a `{ zoneId, name? }` object (e.g. the output of a `Zone` resource or
 *     {@link importZone}).
 */
export type Reference = string | { zoneId: string; name?: string };

export const isId = (zone: string): boolean => /^[a-f0-9]{32}$/i.test(zone);

export const canonicalZoneName = (name: string): string => name.replace(/\.+$/, "").toLowerCase();

export const matchesZoneHostname = (zoneName: string, hostname: string): boolean => {
  const zone = canonicalZoneName(zoneName);
  const host = canonicalZoneName(hostname);
  return host === zone || host.endsWith(`.${zone}`);
};

export const resolveZoneId = ({
  accountId,
  zone,
  hostname,
}: {
  accountId: string;
  zone: Reference | undefined;
  hostname: string;
}) =>
  Effect.gen(function* () {
    if (typeof zone === "object") return zone.zoneId;
    if (typeof zone === "string" && isId(zone)) return zone;

    const lookup = zone ?? hostname;
    for (const candidate of zoneNameCandidates(lookup)) {
      const match = yield* findZoneByName({ accountId, name: candidate });
      if (match) return match.id;
    }
    return yield* new ZoneLookupInvalidProps({
      message: `Cloudflare zone not found for ${lookup}`,
    });
  });

type ZoneListItem = {
  id: string;
  name: string;
  account: { id?: string | null };
};

export const findZoneByName = ({
  accountId,
  name,
}: {
  accountId: string;
  name: string;
}): Effect.Effect<
  ZoneListItem | undefined,
  zones.ListZonesError,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const matches = yield* findZonesByName({ accountId, name });
    return matches[0];
  });

/** Find every exact, account-scoped match across all API pages. */
const findZonesByNameFrom = <R>(
  accountId: string,
  name: string,
  pages: Stream.Stream<zones.ListZonesResponse, zones.ListZonesError, R>,
): Effect.Effect<ZoneListItem[], zones.ListZonesError, R> =>
  pages.pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages).flatMap((page) =>
        (page.result ?? [])
          .filter(
            (candidate) =>
              candidate.account.id === accountId &&
              canonicalZoneName(candidate.name) === canonicalZoneName(name),
          )
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            account: { id: candidate.account.id },
          })),
      ),
    ),
  );

export const findZonesByName = ({
  accountId,
  name,
}: {
  accountId: string;
  name: string;
}): Effect.Effect<ZoneListItem[], zones.ListZonesError, Credentials | HttpClient.HttpClient> =>
  findZonesByNameFrom(
    accountId,
    name,
    zones.listZones.pages({ account: { id: accountId }, name, perPage: 100 }),
  );

/**
 * Exhaustively enumerate every zone in an account. Used by `list()` lifecycle
 * operations on zone-scoped resources to fan out across all zones. Returns only
 * the stable `{ id, name }` pair each caller needs to drive a per-zone list.
 */
export const listAllZones = (
  accountId: string,
): Effect.Effect<
  { id: string; name: string }[],
  zones.ListZonesError,
  Credentials | HttpClient.HttpClient
> =>
  zones.listZones.pages({ account: { id: accountId } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) =>
        (page.result ?? []).map((zone) => ({ id: zone.id, name: zone.name })),
      ),
    ),
  );

/** Hostname plus each parent label, longest first — used to infer a zone. */
export const zoneNameCandidates = (hostname: string): string[] => {
  const parts = canonicalZoneName(hostname).split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
};
