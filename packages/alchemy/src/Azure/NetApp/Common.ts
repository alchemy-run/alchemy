import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  orUndefinedIfNotFound,
  requireSinglePage,
  stackAndStage,
} from "../Arm.ts";

/** Polling budget for NetApp long-running operations (up to ~10 minutes). */
export const LRO_BUDGET = { interval: "5 seconds", times: 120 } as const;

/**
 * NetApp Files rejects writes and deletes while a sibling or parent
 * operation is still running, and rejects a parent delete while its
 * children are still draining. Both surface as typed conflicts; retry them
 * (bounded, ~5 minutes).
 */
export const whileBusy = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "CannotDeleteResource" || e._tag === "ResourceConflict",
      schedule: Schedule.spaced("10 seconds"),
      times: 30,
    }),
  );

/**
 * Physical name for a NetApp resource: letters, digits, `-` and `_`,
 * starting with a letter (volumes require it; harmless elsewhere).
 */
export const createNetAppName = Effect.fn(function* (
  id: string,
  maxLength: number,
  lowercase = false,
) {
  const name = (yield* createPhysicalName({ id, maxLength, lowercase }))
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-zA-Z]/.test(name) ? name : `n${name.slice(1)}`;
});

/** Segments of a NetApp ARM ID (`/netAppAccounts/{a}/capacityPools/{p}/...`). */
export const parseNetAppId = (armId: string | undefined) => ({
  resourceGroup: armId?.match(/\/resourceGroups\/([^/]+)/i)?.[1],
  account: armId?.match(/\/netAppAccounts\/([^/]+)/i)?.[1],
  pool: armId?.match(/\/capacityPools\/([^/]+)/i)?.[1],
  volume: armId?.match(/\/volumes\/([^/]+)/i)?.[1],
  name: armId?.split("/").pop(),
});

/** Observe a NetApp account; `undefined` when it does not exist. */
export const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    netapp.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );

/** Observe a capacity pool; `undefined` when it does not exist. */
export const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  poolName: string,
) =>
  orUndefinedIfNotFound(
    netapp.GetPool({
      subscriptionId,
      resourceGroupName,
      accountName,
      poolName,
    }),
  );

/** Observe a volume; `undefined` when it does not exist. */
export const getVolume = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  poolName: string,
  volumeName: string,
) =>
  orUndefinedIfNotFound(
    netapp.GetVolume({
      subscriptionId,
      resourceGroupName,
      accountName,
      poolName,
      volumeName,
    }),
  );

/** Location of the parent account (children must live in the same region). */
export const accountLocation = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* netapp.GetAccount({
    subscriptionId,
    resourceGroupName,
    accountName,
  });
  return account.location;
});

/**
 * Untagged children (snapshots, buckets, volume groups) count as owned
 * when their tagged parent carries this stack's and stage's ownership tags.
 */
export const ownedByStage = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage
  );
});

/** Every NetApp account in the subscription. */
export const listAllAccounts = Effect.fn(function* (subscriptionId: string) {
  // An unregistered Microsoft.NetApp namespace holds no accounts.
  const page = yield* orUndefinedIfNotFound(
    netapp
      .ListAccountBySubscription({ subscriptionId })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListAccountBySubscription", page),
        ),
      ),
  );
  return page?.value ?? [];
});

/** Resource group + name of each listed account (entries without either dropped). */
export const accountRefs = (
  accounts: ReadonlyArray<{ id?: string; name?: string }>,
) =>
  accounts.flatMap((account) => {
    const { resourceGroup } = parseNetAppId(account.id);
    return resourceGroup && account.name
      ? [{ resourceGroup, accountName: account.name }]
      : [];
  });

/** Resource group, account, and name of each listed pool. */
export const poolRefs = (pools: ReadonlyArray<{ id?: string }>) =>
  pools.flatMap((pool) => {
    const { resourceGroup, account, name } = parseNetAppId(pool.id);
    return resourceGroup && account && name
      ? [{ resourceGroup, account, name }]
      : [];
  });

/** Every capacity pool of every NetApp account in the subscription. */
export const listAllPools = Effect.fn(function* (subscriptionId: string) {
  const accounts = yield* listAllAccounts(subscriptionId);
  const pools = yield* Effect.forEach(
    accountRefs(accounts),
    ({ resourceGroup, accountName }) =>
      orUndefinedIfNotFound(
        netapp
          .ListPools({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName,
          })
          .pipe(Effect.flatMap((page) => requireSinglePage("ListPools", page))),
      ).pipe(Effect.map((page) => page?.value ?? [])),
  );
  return pools.flat();
});

/**
 * True when every value set in `desired` equals the observed value
 * (recursively). Keys left `undefined` in `desired` are not compared.
 */
export const matchesObserved = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => matchesObserved(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matchesObserved(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

export const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase().replace(/\s/g, "") === b?.toLowerCase().replace(/\s/g, "");

/** NetApp export policy rule (NFS/SMB client access). */
export interface NetAppExportPolicyRule {
  /** Order index of the rule (1-5). */
  ruleIndex: number;
  /** Client ingress spec: comma-separated IPv4 CIDRs, host addresses, and host names. */
  allowedClients: string;
  /** Read-only access. */
  unixReadOnly?: boolean;
  /** Read and write access. */
  unixReadWrite?: boolean;
  /** Allow NFSv3 protocol (NFSv3 volumes only). */
  nfsv3?: boolean;
  /** Allow NFSv4.1 protocol (NFSv4.1 volumes only). */
  nfsv41?: boolean;
  /** Allow CIFS protocol. */
  cifs?: boolean;
  /** Whether clients have root access. @default true */
  hasRootAccess?: boolean;
  /** Who may change file ownership. */
  chownMode?: "Restricted" | "Unrestricted";
  /** Kerberos5 read-only access. */
  kerberos5ReadOnly?: boolean;
  /** Kerberos5 read and write access. */
  kerberos5ReadWrite?: boolean;
  /** Kerberos5i read-only access. */
  kerberos5iReadOnly?: boolean;
  /** Kerberos5i read and write access. */
  kerberos5iReadWrite?: boolean;
  /** Kerberos5p read-only access. */
  kerberos5pReadOnly?: boolean;
  /** Kerberos5p read and write access. */
  kerberos5pReadWrite?: boolean;
}
