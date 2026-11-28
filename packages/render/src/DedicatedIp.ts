import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RenderDeployFailedError } from "./Errors.ts";
import * as Api from "./internal/Api.ts";
import { pollUntil } from "./internal/Poll.ts";
import type { Providers } from "./Providers.ts";
import type { DedicatedIpStatus, Region } from "./Types.ts";

export interface DedicatedIpProps {
  /** Descriptive name for the dedicated outbound IP set. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Deployment region (`oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`). Changing it replaces the dedicated IP allocation. */
  region: Region;
  /** Optional free-form description. */
  description?: string;
  /** Optional Render environment IDs to scope outbound routing to (empty applies workspace-wide in the region). */
  environmentIds?: string[];
}

export interface DedicatedIpAttributes {
  /** Dedicated IP resource ID (`dip-...`). */
  id: string;
  /** Allocation name. */
  name: string;
  /** Owner workspace ID. */
  ownerId: string;
  /** Region of allocation. */
  region: string;
  /** Description. */
  description: string;
  /** Scoped Render environment IDs. */
  environmentIds: string[];
  /** Static IPv4 addresses allocated for outbound egress. */
  ips: string[];
  /** Allocation lifecycle status (`CREATING`, `RUNNING`, `FAILED`, ...). */
  status: DedicatedIpStatus;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601), if available. */
  updatedAt?: string;
}

export interface DedicatedIpLookup {
  /** Look up an existing dedicated IP set by ID. */
  id?: string;
  /** Look up an existing dedicated IP set by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

export type DedicatedIp = Resource<
  "Render.DedicatedIp",
  DedicatedIpProps,
  DedicatedIpAttributes,
  never,
  Providers,
  DedicatedIpLookup
>;

/**
 * Allocates static outbound IPv4 egress addresses in a region so external
 * databases or third-party firewalls can allowlist Render services.
 *
 * Creation is asynchronous; Alchemy polls until allocation status reaches `RUNNING`
 * and populates `ips`.
 *
 * **Example:** Dedicated egress IP for Oregon services
 * ```typescript
 * const egress = yield* Render.DedicatedIp("OregonEgress", {
 *   name: "oregon-egress",
 *   region: "oregon",
 *   environmentIds: [prodEnv.id],
 * });
 * ```
 *
 * @resource
 * @product Networking
 * @category Networking
 */
export const DedicatedIp = Resource<DedicatedIp>("Render.DedicatedIp");

const mapDedicatedIp = (dip: RenderSdk.DedicatedIP): DedicatedIpAttributes => ({
  id: dip.id,
  name: dip.name,
  ownerId: dip.ownerId,
  region: dip.region,
  description: dip.description,
  environmentIds: dip.environmentIds ?? [],
  ips: dip.ips ?? [],
  status: dip.status,
  createdAt: dip.createdAt,
  updatedAt: dip.updatedAt,
});

const waitForDedicatedIpRunning = (id: string) =>
  pollUntil({
    operation: "dedicated IP allocation",
    resourceId: id,
    check: RenderSdk.getDedicatedIp({ dedicatedIpId: id }),
    statusOf: (dip) => dip.status,
    failIf: (dip) => {
      if (dip.status === "FAILED" || dip.status === "DELETING" || dip.status === "DELETED") {
        return new RenderDeployFailedError({
          resourceType: "Render.DedicatedIp",
          resourceId: id,
          status: dip.status,
          message: `Render DedicatedIp ${id} entered terminal status "${dip.status}"`,
        });
      }
      return undefined;
    },
    isDone: (dip) => dip.status === "RUNNING",
  });

export const DedicatedIpProvider = () =>
  Provider.effect(
    DedicatedIp,
    Effect.succeed({
      stables: ["id", "region", "ips"],
      nuke: {
        dependsOn: ["Render.Environment", "Render.Project"],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const prevRegion = olds.region ?? output?.region;
        if (prevRegion !== undefined && news.region !== prevRegion) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const dip = yield* Api.ignoreNotFound(
            RenderSdk.getDedicatedIp({ dedicatedIpId: output.id }),
          );
          return dip ? mapDedicatedIp(dip) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
        const all = yield* RenderSdk.listDedicatedIps({ ownerId });
        const matched = all.find((d) => d.name === desiredName);
        if (!matched) return undefined;
        const attrs = mapDedicatedIp(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const dip = yield* Api.ignoreNotFound(
            RenderSdk.getDedicatedIp({ dedicatedIpId: props.id }),
          );
          return dip ? mapDedicatedIp(dip) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Api.resolveOwnerId(props.ownerId);
          const all = yield* RenderSdk.listDedicatedIps({ ownerId });
          const matched = all.find((d) => d.name === props.name);
          return matched ? mapDedicatedIp(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const all = yield* RenderSdk.listDedicatedIps({ ownerId });
        return all.map(mapDedicatedIp);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Api.ignoreNotFound(RenderSdk.getDedicatedIp({ dedicatedIpId: output.id }))
          : undefined;

        if (!existing) {
          const ownerId = yield* Api.resolveOwnerId(news.ownerId);
          const created = yield* RenderSdk.createDedicatedIp({
            name: desiredName,
            ownerId,
            region: news.region,
            ...(news.description !== undefined ? { description: news.description } : {}),
            ...(news.environmentIds !== undefined ? { environmentIds: news.environmentIds } : {}),
          });
          const ready =
            created.status === "RUNNING" ? created : yield* waitForDedicatedIpRunning(created.id);
          return mapDedicatedIp(ready);
        }

        const updated = yield* RenderSdk.updateDedicatedIp({
          dedicatedIpId: existing.id,
          name: desiredName,
          ...(news.description !== undefined ? { description: news.description } : {}),
          ...(news.environmentIds !== undefined ? { environmentIds: news.environmentIds } : {}),
        });
        return mapDedicatedIp(updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Api.deleteIdempotent(RenderSdk.deleteDedicatedIp({ dedicatedIpId: output.id }));
      }),
    }),
  );
