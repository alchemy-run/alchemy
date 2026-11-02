import * as dns from "@distilled.cloud/stackit/dns";
import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { ReadWriteZoneClient } from "./ReadWriteZone.ts";
import type { ReadZoneClient } from "./ReadZone.ts";
import type { WriteZoneClient } from "./WriteZone.ts";
import type { Zone } from "./Zone.ts";

/**
 * Shared HTTP scaffolding for DNS bindings.
 * NOT exported from index.ts.
 *
 * Permissions bind on the project holding the zone: STACKIT has no role binding
 * on a single zone (see `StackitBindings`). The names are the actions in each
 * operation's `x-stackit-authorization` in the DNS spec. They grant through a
 * custom role because no STACKIT source lists predefined DNS roles.
 *
 * There is no per-operation least privilege here: `dns.zone.list` authorizes every
 * read, and `dns.zone.create` every zone and record set change, on every zone in
 * the project.
 */
export const DNS_READ_ACCESS: StackitBindings.Access = { permissions: ["dns.zone.list"] };
export const DNS_WRITE_ACCESS: StackitBindings.Access = { permissions: ["dns.zone.create"] };
export const DNS_READ_WRITE_ACCESS: StackitBindings.Access = {
  permissions: ["dns.zone.create", "dns.zone.list"],
};

/** Build a binding over one operation on a zone: `<Op>Http.ts` is one call to it. */
export const makeZoneHttpBinding = <
  I extends { projectId: string; zoneId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.DNS.GetZone`. */
  tag: string;
  /** What the operation needs on the project holding the zone. */
  access: StackitBindings.Access;
  /** The distilled operation; the zone's project and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (zone: Zone) => ({ projectId: zone.projectId, zoneId: zone.zoneId }),
    grants: (zone) => [StackitBindings.grantOn(zone, options.access)],
  });

/** A bound zone's identifiers, read when a call runs. */
export interface ZoneIdentifiers {
  readonly projectId: Effect.Effect<string>;
  readonly zoneId: Effect.Effect<string>;
}

type ZoneRequest<I> = Omit<I, "projectId" | "zoneId">;

/** Inject the zone's identifiers into every request of an operation. */
const onZone =
  (zone: ZoneIdentifiers) =>
  <I extends { projectId: string; zoneId: string }, A, E>(run: (input: I) => Effect.Effect<A, E>) =>
    Effect.fnUntraced(function* (request?: ZoneRequest<I>) {
      const projectId = yield* zone.projectId;
      const zoneId = yield* zone.zoneId;
      // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
      return yield* run({ ...request, projectId, zoneId } as unknown as I);
    });

/**
 * Build the read client for a zone. Its operations are resolved with the host's
 * credentials once, when the layer is built.
 */
export const makeReadZoneClient = Effect.gen(function* () {
  const getZone = yield* StackitBindings.withCredentials(dns.getZone);
  const getRecordSet = yield* StackitBindings.withCredentials(dns.getRecordSet);
  const listRecordSets = yield* StackitBindings.withCredentials(dns.listRecordSets);
  const exportRecordSets = yield* StackitBindings.withCredentials(dns.exportRecordSets);
  return (zone: ZoneIdentifiers): ReadZoneClient => {
    const on = onZone(zone);
    return {
      getZone: on(getZone),
      getRecordSet: on(getRecordSet),
      listRecordSets: on(listRecordSets),
      exportRecordSets: on(exportRecordSets),
    };
  };
});

/**
 * Build the write client for a zone. Its operations are resolved with the
 * host's credentials once, when the layer is built.
 */
export const makeWriteZoneClient = Effect.gen(function* () {
  const createRecordSet = yield* StackitBindings.withCredentials(dns.createRecordSet);
  const updateRecordSet = yield* StackitBindings.withCredentials(dns.partialUpdateRecordSet);
  const updateRecords = yield* StackitBindings.withCredentials(dns.partialUpdateRecord);
  const deleteRecordSet = yield* StackitBindings.withCredentials(dns.deleteRecordSet);
  const importRecordSets = yield* StackitBindings.withCredentials(dns.importRecordSets);
  const retrieveZone = yield* StackitBindings.withCredentials(dns.retrieveZone);
  return (zone: ZoneIdentifiers): WriteZoneClient => {
    const on = onZone(zone);
    return {
      createRecordSet: on(createRecordSet),
      updateRecordSet: on(updateRecordSet),
      updateRecords: on(updateRecords),
      deleteRecordSet: on(deleteRecordSet),
      importRecordSets: on(importRecordSets),
      retrieveZone: on(retrieveZone),
    };
  };
});

/** Build the client with every read and write operation on a zone. */
export const makeReadWriteZoneClient = Effect.gen(function* () {
  const makeRead = yield* makeReadZoneClient;
  const makeWrite = yield* makeWriteZoneClient;
  return (zone: ZoneIdentifiers): ReadWriteZoneClient => ({
    ...makeRead(zone),
    ...makeWrite(zone),
  });
});

/**
 * Build a binding whose client groups several operations on a zone: one grant
 * for the access level, then the client for the bound zone.
 */
export const makeZoneClientHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.DNS.ReadZone`. */
  tag: string;
  /** What the client needs on the project holding the zone. */
  access: StackitBindings.Access;
  /** Build the client; resolved when the layer is built. */
  makeClient: Effect.Effect<(zone: ZoneIdentifiers) => Client>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (zone: Zone) {
      const projectId = yield* zone.projectId;
      const zoneId = yield* zone.zoneId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${zone})`({
          grants: [StackitBindings.grantOn(zone, options.access)],
        });
      }
      return makeClient({ projectId, zoneId });
    });
  });

/**
 * Build a binding over a resolver operation: these have no project or zone in
 * their path, so nothing is bound and no role is granted. The host still gets a
 * service account and key, to sign with.
 */
export const makeResolverHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.DNS.Lookup`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({});
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* run(request);
      });
    });
  });
