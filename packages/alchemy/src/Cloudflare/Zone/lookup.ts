import {
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

/**
 * Reference to an existing Cloudflare Zone. Accepts:
 *   - a zone id (32 hex characters),
 *   - a zone name (`example.com`), or
 *   - a `{ zoneId, name? }` object (e.g. the output of a `Zone` resource or
 *     {@link importZone}).
 */
export type Reference = string | { zoneId: string; name?: string };

export const isId = (zone: string): boolean => /^[a-f0-9]{32}$/i.test(zone);

export const matchesZoneHostname = (
  zoneName: string,
  hostname: string,
): boolean => hostname === zoneName || hostname.endsWith(`.${zoneName}`);

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
    return yield* Effect.fail(
      new Error(`Cloudflare zone not found for ${lookup}`),
    );
  });

/**
 * The caller's memo for {@link inferZoneIdForHostname} — one map per reconcile
 * pass. It holds the *lookup effect* rather than the resolved id so that
 * concurrent inferences of the same hostname share one in-flight lookup.
 */
export type ZoneCache = Map<
  string,
  Effect.Effect<string, never, CloudflareEnvironment | Credentials>
>;

/**
 * {@link resolveZoneId} against the ambient account, for callers that only
 * have a hostname: no explicit zone reference, a memo, and an unresolvable
 * hostname as a defect rather than a typed failure.
 *
 * Listing the account's zones and matching locally is a trap: the list
 * endpoint paginates (20 zones per page), so a hostname whose zone sits on a
 * later page silently fails to resolve. `resolveZoneId` walks the label
 * hierarchy with exact `?name=` lookups instead, which makes the account's
 * zone count irrelevant.
 *
 * The memo holds the lookup effect, built with `Effect.cached`, so concurrent
 * inferences of the same hostname share one in-flight walk rather than each
 * starting their own. Installing it is not strictly atomic — worst case two
 * fibers interleave before the `set` and one duplicate GET goes out.
 */
export const inferZoneIdForHostname = (
  hostname: string,
  zoneCache: ZoneCache,
): Effect.Effect<string, never, CloudflareEnvironment | Credentials> =>
  Effect.gen(function* () {
    let lookup = zoneCache.get(hostname);
    if (!lookup) {
      lookup = yield* Effect.cached(
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          return yield* resolveZoneId({
            accountId,
            zone: undefined,
            hostname,
          }).pipe(
            Effect.catch(() =>
              Effect.die(
                `Could not infer Cloudflare Zone for hostname "${hostname}". ` +
                  "Ensure the parent zone exists in this account.",
              ),
            ),
          );
        }),
      );
      zoneCache.set(hostname, lookup);
    }
    return yield* lookup;
  });

type ZoneListItem = {
  id: string;
  name: string;
  account: { id?: string | null };
};

type ZoneListResponse = {
  success: boolean;
  errors?: { message?: string }[];
  result?: ZoneListItem[];
};

export const findZoneByName = ({
  accountId,
  name,
}: {
  accountId: string;
  name: string;
}): Effect.Effect<ZoneListItem | undefined, Error, Credentials> =>
  Effect.gen(function* () {
    const credentialsEffect = yield* Credentials;
    const credentials = yield* credentialsEffect;
    const url = new URL(`${credentials.apiBaseUrl}/zones`);
    url.searchParams.set("account.id", accountId);
    url.searchParams.set("name", name);
    url.searchParams.set("per_page", "1");

    const json = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: formatHeaders(credentials),
        });
        return (await response.json()) as ZoneListResponse;
      },
      catch: (cause) => new Error(`Failed to list Cloudflare zones`, { cause }),
    });

    if (!json.success) {
      return yield* Effect.fail(
        new Error(
          json.errors?.map((error) => error.message).join(", ") ??
            `Failed to list Cloudflare zones`,
        ),
      );
    }

    return json.result?.find(
      (candidate) =>
        candidate.name === name && candidate.account.id === accountId,
    );
  });

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
  const parts = hostname.split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
};
