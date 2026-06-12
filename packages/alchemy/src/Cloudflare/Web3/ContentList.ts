import * as web3 from "@distilled.cloud/cloudflare/web3";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const Web3HostnameContentListTypeId =
  "Cloudflare.Web3HostnameContentList" as const;
type Web3HostnameContentListTypeId = typeof Web3HostnameContentListTypeId;

/**
 * The kind of content a content-list entry blocks: a CID (`cid`) or a
 * content path (`content_path`).
 */
export type Web3ContentListEntryType = "cid" | "content_path";

/**
 * A single entry of an IPFS universal-path content list.
 */
export interface Web3ContentListEntry {
  /**
   * The CID or content path of content to block, e.g.
   * `QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco` (`cid`) or
   * `/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/wiki` (`content_path`).
   */
  content: string;
  /**
   * The type of content list entry to block.
   */
  type: Web3ContentListEntryType;
  /**
   * An optional description of the content list entry.
   */
  description?: string;
}

export interface Web3HostnameContentListProps {
  /**
   * The zone the hostname belongs to.
   *
   * Stable — moving to another zone triggers a replacement.
   */
  zoneId: string;
  /**
   * The Web3 hostname the content list belongs to. Must be an
   * `ipfs_universal_path` hostname — other targets reject content-list
   * operations.
   *
   * Stable — pointing at another hostname triggers a replacement.
   */
  hostnameId: string;
  /**
   * Behavior of the content list. Cloudflare currently only supports
   * `block`.
   * @default "block"
   */
  action?: "block";
  /**
   * The full desired set of content list entries. The list is replaced
   * declaratively on every change (bulk PUT) — entries not present here
   * are removed.
   * @default []
   */
  entries?: Web3ContentListEntry[];
}

export interface Web3HostnameContentListAttributes {
  /** The zone the hostname belongs to. */
  zoneId: string;
  /** The Web3 hostname the content list belongs to. */
  hostnameId: string;
  /** Behavior of the content list. */
  action: "block";
  /** The current content list entries. */
  entries: Web3ContentListEntry[];
}

export type Web3HostnameContentList = Resource<
  Web3HostnameContentListTypeId,
  Web3HostnameContentListProps,
  Web3HostnameContentListAttributes,
  never,
  Providers
>;

/**
 * The IPFS content-blocking list of a Web3 universal-path gateway hostname —
 * blocks specific CIDs or content paths from being served.
 *
 * The content list is a per-hostname singleton: it always exists for an
 * `ipfs_universal_path` hostname (empty by default), so this resource never
 * creates or deletes a physical object. Reconciliation replaces the whole
 * list declaratively via the bulk PUT, and destroy resets the list to empty.
 *
 * @section Blocking content
 * @example Block a CID and a content path
 * ```typescript
 * const gateway = yield* Cloudflare.Web3Hostname("UniversalGateway", {
 *   zoneId: zone.zoneId,
 *   name: "gateway.example.com",
 *   target: "ipfs_universal_path",
 * });
 *
 * yield* Cloudflare.Web3HostnameContentList("Blocklist", {
 *   zoneId: zone.zoneId,
 *   hostnameId: gateway.hostnameId,
 *   entries: [
 *     {
 *       type: "cid",
 *       content: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
 *       description: "blocked CID",
 *     },
 *     {
 *       type: "content_path",
 *       content: "/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/wiki",
 *     },
 *   ],
 * });
 * ```
 *
 * @example Clear the blocklist
 * ```typescript
 * // An empty entries array removes every block (also what destroy does).
 * yield* Cloudflare.Web3HostnameContentList("Blocklist", {
 *   zoneId: zone.zoneId,
 *   hostnameId: gateway.hostnameId,
 *   entries: [],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/web3/
 */
export const Web3HostnameContentList = Resource<Web3HostnameContentList>(
  Web3HostnameContentListTypeId,
);

/**
 * Returns true if the given value is a Web3HostnameContentList resource.
 */
export const isWeb3HostnameContentList = (
  value: unknown,
): value is Web3HostnameContentList =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === Web3HostnameContentListTypeId;

export const Web3HostnameContentListProvider = () =>
  Provider.succeed(Web3HostnameContentList, {
    stables: ["zoneId", "hostnameId"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as Partial<Web3HostnameContentListProps>;
      const n = news as Web3HostnameContentListProps;
      // zoneId/hostnameId are Input<string>; compare only once both
      // sides are concrete. The content list is a sub-singleton of the
      // hostname — pointing elsewhere replaces it.
      const oldZone = output?.zoneId ?? o.zoneId;
      if (
        typeof oldZone === "string" &&
        typeof n.zoneId === "string" &&
        oldZone !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      const oldHostname = output?.hostnameId ?? o.hostnameId;
      if (
        typeof oldHostname === "string" &&
        typeof n.hostnameId === "string" &&
        oldHostname !== n.hostnameId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      const hostnameId =
        output?.hostnameId ??
        (typeof olds?.hostnameId === "string" ? olds.hostnameId : undefined);
      if (zoneId === undefined || hostnameId === undefined) return undefined;
      // Settings-singleton semantics: the list always exists for a
      // universal-path hostname (empty by default), so it is never
      // `Unowned`. A deleted hostname reads as gone.
      return yield* observeContentList(zoneId, hostnameId);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const hostnameId = news.hostnameId as string;
      const desired: Web3HostnameContentListAttributes = {
        zoneId,
        hostnameId,
        action: news.action ?? "block",
        entries: news.entries ?? [],
      };

      // Observe — read the live list; the singleton always exists for a
      // universal-path hostname, so "missing" only means the hostname
      // itself is gone (which is a real failure for reconcile).
      const observed = yield* observeContentList(zoneId, hostnameId);

      // Sync — the bulk PUT replaces action + entries declaratively;
      // skip the API call entirely on a no-op.
      if (observed && sameContentList(observed, desired)) {
        return observed;
      }
      yield* web3.putHostnameIpfsUniversalPathContentList({
        zoneId,
        identifier: hostnameId,
        action: desired.action,
        entries: desired.entries,
      });
      return desired;
    }),

    delete: Effect.fn(function* ({ output }) {
      // There is no DELETE endpoint — destroying the resource resets the
      // singleton to its empty default. If the hostname itself is already
      // gone (or no longer a universal-path gateway), there is nothing
      // left to reset.
      yield* web3
        .putHostnameIpfsUniversalPathContentList({
          zoneId: output.zoneId,
          identifier: output.hostnameId,
          action: "block",
          entries: [],
        })
        .pipe(
          Effect.catchTag(
            ["Web3HostnameNotFound", "InvalidWeb3HostnameTarget"],
            () => Effect.void,
          ),
        );
    }),
  });

/**
 * Read the content list (action) plus its entries, mapping a gone hostname
 * (`Web3HostnameNotFound`, code 1002) or a hostname that is not a
 * universal-path gateway (`InvalidWeb3HostnameTarget`, code 1006) to
 * `undefined`.
 */
const observeContentList = (zoneId: string, hostnameId: string) =>
  Effect.gen(function* () {
    const list = yield* web3.getHostnameIpfsUniversalPathContentList({
      zoneId,
      identifier: hostnameId,
    });
    const entries = yield* web3.listHostnameIpfsUniversalPathContentListEntries(
      { zoneId, identifier: hostnameId },
    );
    return {
      zoneId,
      hostnameId,
      action: (list.action ?? "block") as "block",
      entries: (entries.entries ?? []).map(
        (entry): Web3ContentListEntry => ({
          content: entry.content ?? "",
          type: (entry.type ?? "cid") as Web3ContentListEntryType,
          ...(entry.description != null
            ? { description: entry.description }
            : {}),
        }),
      ),
    } satisfies Web3HostnameContentListAttributes;
  }).pipe(
    Effect.catchTag(["Web3HostnameNotFound", "InvalidWeb3HostnameTarget"], () =>
      Effect.succeed(undefined),
    ),
  );

/**
 * Order-insensitive comparison of two content lists by (content, type,
 * description).
 */
const sameContentList = (
  observed: Web3HostnameContentListAttributes,
  desired: Web3HostnameContentListAttributes,
) =>
  observed.action === desired.action &&
  observed.entries.length === desired.entries.length &&
  serializeEntries(observed.entries) === serializeEntries(desired.entries);

const serializeEntries = (entries: Web3ContentListEntry[]) =>
  entries
    .map((entry) => `${entry.type} ${entry.content} ${entry.description ?? ""}`)
    .sort()
    .join("");
