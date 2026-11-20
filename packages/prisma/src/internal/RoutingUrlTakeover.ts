import { normalizeHostname } from "./RoutingUrlRequiredRecords.ts";

/**
 * Whether a `Prisma.RoutingUrl` manages a RoutingUrl row. It writes its
 * `logicalId` on every row it creates or takes over; Prisma leaves the
 * `logicalId` empty on the rows it records for the Console, its backfill and
 * custom domains.
 */
export const isManagedByRoutingUrl = (row: { readonly logicalId: string | null }) =>
  row.logicalId !== null;

/** Whether a `Prisma.RoutingUrl` manages a row for `hostname` among `rows`. */
export const hostnameManagedByRoutingUrl = (
  rows: ReadonlyArray<{ readonly logicalId: string | null; readonly hostname: string }>,
  hostname: string,
) =>
  rows.some(
    (row) =>
      isManagedByRoutingUrl(row) && normalizeHostname(row.hostname) === normalizeHostname(hostname),
  );
