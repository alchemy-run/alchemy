import * as dns from "@distilled.cloud/stackit/dns";
import * as Effect from "effect/Effect";

/** Service id the DNS API needs enabled per project. */
export const DNS_SERVICE_ID = "cloud.stackit.dns";

/**
 * Zone and record set operations settle within seconds; the budget allows
 * for a slow API without hanging a deploy.
 */
export const DNS_TIMEOUT = "5 minutes";

/** Normalize a DNS name for comparison: lowercase, no trailing dot. */
export const normalizeDnsName = (name: string): string => name.toLowerCase().replace(/\.+$/, "");

/** A DNS create/update finished. */
export const isSucceeded = (state: string | undefined): boolean =>
  state === "CREATE_SUCCEEDED" || state === "UPDATE_SUCCEEDED";

/**
 * `GetZone`; `undefined` when the zone is gone. STACKIT soft-deletes zones
 * (restorable, state `DELETE_SUCCEEDED`), so that state counts as gone, as
 * does the typed `NotFound`.
 */
export const getZoneOrUndefined = (projectId: string, zoneId: string) =>
  dns.getZone({ projectId, zoneId }).pipe(
    Effect.map(({ zone }) => (zone.state === "DELETE_SUCCEEDED" ? undefined : zone)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/**
 * `GetRecordSet`; `undefined` when the record set is gone (typed `NotFound`,
 * or soft-deleted in state `DELETE_SUCCEEDED`).
 */
export const getRecordSetOrUndefined = (projectId: string, zoneId: string, rrSetId: string) =>
  dns.getRecordSet({ projectId, zoneId, rrSetId }).pipe(
    Effect.map(({ rrset }) => (rrset.state === "DELETE_SUCCEEDED" ? undefined : rrset)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );
