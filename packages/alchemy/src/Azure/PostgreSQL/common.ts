import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure Database for PostgreSQL. */
export const POSTGRES_NAMESPACE = "Microsoft.DBforPostgreSQL";

/** Address of a flexible server. */
export interface ServerRef {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly serverName: string;
}

/**
 * Only the server's own address. Child refs carry extra keys (e.g.
 * `databaseName`) that distilled would otherwise serialize as a request
 * body, which `fetch` rejects on GET.
 */
export const serverOnly = (ref: ServerRef): ServerRef => ({
  subscriptionId: ref.subscriptionId,
  resourceGroupName: ref.resourceGroupName,
  serverName: ref.serverName,
});

export const getServer = (ref: ServerRef) =>
  orUndefinedIfNotFound(postgresql.GetServer(serverOnly(ref)));

/**
 * Child resources (databases, firewall rules, administrators, …) carry no
 * tags or free-form fields, so ownership is inferred from the parent server:
 * a child is Alchemy-owned when its server carries this stack/stage's
 * ownership tags.
 */
export const serverOwnedByStack = (ref: ServerRef) =>
  Effect.gen(function* () {
    const server = yield* getServer(ref);
    if (server === undefined) return false;
    const tags = tagRecord(server.tags);
    const { stack, stage } = yield* stackAndStage;
    return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
  });

/**
 * Server-level operations on a flexible server are serialized: while one
 * runs (an update, a restart, another child's create/delete), further
 * operations fail with `ServerBusy` / `OperationInProgress`. Retry them,
 * bounded.
 */
export const whileServerBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/** Server states that settle without further action. */
const SETTLED = new Set(["Ready", "Stopped", "Disabled"]);

/**
 * Wait until the server leaves a transitional state (`Updating`,
 * `Restarting`, `Starting`, …) so the next mutation is not rejected.
 */
export const waitServerSettled = (ref: ServerRef) =>
  getServer(ref).pipe(
    Effect.repeat({
      until: (server) =>
        server === undefined || SETTLED.has(server.properties?.state ?? ""),
      schedule: Schedule.spaced("10 seconds"),
      times: 60,
    }),
  );
