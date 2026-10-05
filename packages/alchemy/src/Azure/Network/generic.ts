import type { AzureOpContext } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { InstanceId } from "../../InstanceId.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { Stack } from "../../Stack.ts";
import type { Stage } from "../../Stage.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import {
  parentOwned,
  waitNetworkGone,
  waitNetworkGoneSlow,
  waitNetworkProvisioned,
  waitNetworkProvisionedSlow,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

// Shared provider skeleton for Microsoft.Network resources whose lifecycle
// is a plain GET / PUT / DELETE on one ARM path. Internal: not exported
// from index.ts.

/**
 * Location of one resource: its resource group, the names of its parents
 * (keyed by the attribute/prop name, e.g. `networkManager`), and its name.
 */
export type NetworkPath = {
  readonly resourceGroup: string;
  readonly name: string;
  readonly [parent: string]: string;
};

/** The fields every Microsoft.Network GET response shares. */
export interface ArmObserved {
  readonly id?: string;
  readonly name?: string;
  readonly location?: string;
  readonly tags?: Record<string, string | undefined>;
  // `object &` opts out of weak-type detection: some responses (scope
  // connections, NSP profiles) have properties without `provisioningState`.
  readonly properties?: object & { readonly provisioningState?: string };
}

type Op<A> = Effect.Effect<A, any, AzureOpContext>;

/** PUT body fields besides the path (location, tags, sku, properties, ...). */
export type NetworkBody = { readonly [key: string]: unknown };

export interface NetworkResourceSpec<
  Res extends ResourceLike,
  Obs extends ArmObserved,
  B extends object,
> {
  /** Human label for wait/timeout messages, e.g. `"IP group"`. */
  readonly label: string;
  /** Attribute holding the resource name, e.g. `"ipGroupName"`. */
  readonly nameAttr: keyof Res["Attributes"] & string;
  /**
   * Parent names, in path order (props and attributes use the same key).
   * Changing one replaces the resource.
   */
  readonly parents?: ReadonlyArray<string>;
  /**
   * Whether the resource is a tracked ARM resource with `location` and
   * `tags`. Untracked children take ownership from {@link ownerTags}.
   */
  readonly tracked: boolean;
  /** Physical-name generator. @default 1-80 char Network name */
  readonly physicalName?: (
    id: string,
  ) => Effect.Effect<string, never, InstanceId | Stack | Stage>;
  /** Wait budgets for slow (10+ minute) resources. */
  readonly slow?: boolean;
  /**
   * Readiness state of the observed resource (`Succeeded` = usable,
   * `Failed`/`Canceled` = terminal, anything else = keep polling). Use it
   * when `provisioningState` alone is not enough (e.g. hub routing state).
   * @default `properties.provisioningState`
   */
  readonly readyState?: (observed: Obs) => string | undefined;
  /** Typed delete errors meaning "still referenced, retry". */
  readonly inUseTags?: ReadonlyArray<string>;
  /** Delete the old resource before creating its replacement. */
  readonly deleteFirst?: boolean;
  /**
   * Azure creates the resource implicitly with its parent and refuses to
   * delete it: after `del` (which must swallow that refusal) the resource
   * is left for the parent's delete to remove, so delete does not wait for
   * it to disappear.
   */
  readonly goneWithParent?: boolean;
  /** Extra immutable-field check: true forces a replacement. */
  readonly immutable?: (
    news: Res["Props"],
    output: Res["Attributes"],
  ) => boolean;
  /** Resource provider namespaces to register before the first write. */
  readonly namespaces?: ReadonlyArray<string>;

  readonly get: (
    subscriptionId: string,
    path: NetworkPath,
  ) => Op<Obs | undefined>;
  readonly put: (
    subscriptionId: string,
    path: NetworkPath,
    body: B,
  ) => Op<unknown>;
  readonly del: (subscriptionId: string, path: NetworkPath) => Op<unknown>;
  /**
   * Teardown that must finish before the DELETE (e.g. deprovisioning a
   * BYOIP range). Must tolerate an already-missing resource.
   */
  readonly beforeDelete?: (
    subscriptionId: string,
    path: NetworkPath,
  ) => Op<unknown>;
  /** Tag-only PATCH, used when only tags drifted. @default the full PUT */
  readonly updateTags?: (
    subscriptionId: string,
    path: NetworkPath,
    tags: Record<string, string>,
  ) => Op<unknown>;
  /** Subscription-wide list (tracked resources only). */
  readonly listAll?: (subscriptionId: string) => Op<{
    readonly value?: ReadonlyArray<Obs>;
    readonly nextLink?: string;
  }>;
  /** Tags of the tracked ancestor that owns an untracked child. */
  readonly ownerTags?: (
    subscriptionId: string,
    path: NetworkPath,
  ) => Op<Record<string, string | undefined> | undefined>;

  /** Desired PUT body (without path params) for the new props. */
  readonly body: (
    news: Res["Props"],
    ctx: {
      readonly subscriptionId: string;
      readonly path: NetworkPath;
      readonly location: string;
      readonly tags: Record<string, string>;
      readonly observed: Obs | undefined;
    },
  ) => B;
  /**
   * Whether the observed resource differs from the desired body.
   * @default every field set in the body (except `location`/`tags`) is
   * matched against the observed resource, case-insensitively
   */
  readonly drifted?: (observed: Obs, body: B, news: Res["Props"]) => boolean;
  /**
   * Whether a write-only field (a secret Azure never returns) changed
   * since the previous deploy; true re-sends the PUT.
   */
  readonly writeOnlyChanged?: (
    news: Res["Props"],
    olds: Res["Props"] | undefined,
  ) => boolean;
  /** Attributes from the path and the observed resource. */
  readonly toAttrs: (path: NetworkPath, observed: Obs) => Res["Attributes"];
  /** Types nuke must delete this resource before. */
  readonly dependsOn?: ReadonlyArray<string>;
}

/**
 * True when some field set in `desired` differs from `observed`. Objects
 * compare only the keys `desired` sets, arrays compare element-wise with
 * equal length, strings compare case-insensitively.
 */
export const subsetDiffers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return false;
  if (desired === null) return observed !== null && observed !== undefined;
  if (Array.isArray(desired)) {
    const list = Array.isArray(observed) ? observed : [];
    return (
      desired.length !== list.length ||
      desired.some((item, i) => subsetDiffers(item, list[i]))
    );
  }
  if (typeof desired === "object") {
    if (observed === null || typeof observed !== "object") {
      return Object.values(desired).some((v) => v !== undefined);
    }
    return Object.entries(desired).some(([key, value]) =>
      subsetDiffers(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() !== observed.toLowerCase();
  }
  return desired !== observed;
};

const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** ARM ID → path: resource group, parent segments, and name. */
const pathFromId = (
  armId: string | undefined,
  parents: ReadonlyArray<string>,
): NetworkPath | undefined => {
  const resourceGroup = resourceGroupOf(armId);
  const segments = armId?.split("/providers/Microsoft.Network/")[1]?.split("/");
  if (resourceGroup === undefined || segments === undefined) return undefined;
  // segments: type, name, (childType, childName)*
  const names = segments.filter((_, i) => i % 2 === 1);
  if (names.length !== parents.length + 1) return undefined;
  const path: Record<string, string> = { resourceGroup, name: names.at(-1)! };
  parents.forEach((parent, i) => {
    path[parent] = names[i]!;
  });
  return path as NetworkPath;
};

/**
 * Build the lifecycle of a Microsoft.Network resource from its ARM
 * operations: observe (GET) → ensure + sync (one PUT when missing or any
 * declared field drifted; tag-only drift uses the tags PATCH) → wait for
 * `Succeeded` → attributes. Pass the result to `Provider.succeed`.
 */
export const networkProvider =
  <Res extends ResourceLike>() =>
  <Obs extends ArmObserved, B extends object>(
    spec: NetworkResourceSpec<Res, Obs, B>,
  ) => {
    const parents = spec.parents ?? [];
    const physicalName =
      spec.physicalName ??
      ((id: string) => createPhysicalName({ id, maxLength: 80 }));
    const waitReady = <E, R>(
      label: string,
      get: Effect.Effect<Obs | undefined, E, R>,
    ) =>
      spec.readyState !== undefined
        ? waitForProvisioned(label, get, spec.readyState, {
            interval: spec.slow ? "15 seconds" : "3 seconds",
            times: spec.slow ? 240 : 100,
          })
        : spec.slow
          ? waitNetworkProvisionedSlow(label, get)
          : waitNetworkProvisioned(label, get);
    const waitGone = spec.slow ? waitNetworkGoneSlow : waitNetworkGone;
    const describe = (path: NetworkPath) =>
      `${spec.label} ${[...parents.map((p) => path[p]), path.name].join("/")}`;

    const pathOf = Effect.fn(function* (
      id: string,
      source: Record<string, unknown> | undefined,
      output: Record<string, unknown> | undefined,
    ) {
      const resourceGroup = (output?.resourceGroup ?? source?.resourceGroup) as
        | string
        | undefined;
      if (resourceGroup === undefined) return undefined;
      const path: Record<string, string> = {
        resourceGroup,
        name:
          (output?.[spec.nameAttr] as string | undefined) ??
          (source?.name as string | undefined) ??
          (yield* physicalName(id)),
      };
      for (const parent of parents) {
        const value = (output?.[parent] ?? source?.[parent]) as
          | string
          | undefined;
        if (value === undefined) return undefined;
        path[parent] = value;
      }
      return path as NetworkPath;
    });

    const owned = Effect.fn(function* (
      id: string,
      subscriptionId: string,
      path: NetworkPath,
      observed: Obs,
    ) {
      if (spec.tracked) return yield* isOwned(id, observed.tags);
      if (spec.ownerTags === undefined) return false;
      return yield* parentOwned(yield* spec.ownerTags(subscriptionId, path));
    });

    return {
      stables: [spec.nameAttr, ...parents, "resourceGroup"] as Array<
        Extract<keyof Res["Attributes"], string>
      >,

      list: Effect.fn(function* () {
        if (!spec.tracked || spec.listAll === undefined) {
          return [] as Array<Res["Attributes"]>;
        }
        const { subscriptionId } = yield* AzureEnvironment.current;
        const page = yield* spec
          .listAll(subscriptionId)
          .pipe(Effect.flatMap((page) => requireSinglePage(spec.label, page)));
        return (page.value ?? []).flatMap((observed) => {
          const path = pathFromId(observed.id, parents);
          return hasAnyAlchemyTag(observed.tags) && path !== undefined
            ? [spec.toAttrs(path, observed)]
            : [];
        });
      }),

      diff: Effect.fn(function* ({
        news,
        output,
      }: {
        news: unknown;
        output: Res["Attributes"] | undefined;
      }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const n = news as Record<string, unknown>;
        const o = output as Record<string, unknown>;
        const changed =
          !sameName(n.resourceGroup as string, o.resourceGroup as string) ||
          (n.name !== undefined &&
            !sameName(n.name as string, o[spec.nameAttr] as string)) ||
          parents.some((p) => !sameName(n[p] as string, o[p] as string)) ||
          (spec.tracked &&
            n.location !== undefined &&
            o.location !== undefined &&
            !sameName(n.location as string, o.location as string)) ||
          (spec.immutable?.(news as Res["Props"], output) ?? false);
        if (changed) {
          return spec.deleteFirst
            ? ({ action: "replace", deleteFirst: true } as const)
            : ({ action: "replace" } as const);
        }
        return undefined;
      }),

      read: Effect.fn(function* ({
        id,
        olds,
        output,
      }: {
        id: string;
        olds: Res["Props"] | undefined;
        output: Res["Attributes"] | undefined;
      }) {
        const { subscriptionId } = yield* AzureEnvironment.current;
        const path = yield* pathOf(
          id,
          olds as Record<string, unknown> | undefined,
          output as Record<string, unknown> | undefined,
        );
        if (path === undefined) return undefined;
        const observed = yield* spec.get(subscriptionId, path);
        if (observed === undefined) return undefined;
        const attrs = spec.toAttrs(path, observed);
        return (yield* owned(id, subscriptionId, path, observed))
          ? attrs
          : Unowned(attrs);
      }),

      reconcile: Effect.fn(function* ({
        id,
        news,
        olds,
        output,
      }: {
        id: string;
        news: Res["Props"];
        olds?: Res["Props"] | undefined;
        output: Res["Attributes"] | undefined;
      }) {
        const env = yield* AzureEnvironment.current;
        const { subscriptionId } = env;
        for (const namespace of [
          "Microsoft.Network",
          ...(spec.namespaces ?? []),
        ]) {
          yield* ensureRegistered(subscriptionId, namespace);
        }
        const n = news as Record<string, unknown>;
        const path = (yield* pathOf(
          id,
          n,
          // Only the name is reused from output; parents come from news.
          output === undefined
            ? undefined
            : {
                [spec.nameAttr]: (output as Record<string, unknown>)[
                  spec.nameAttr
                ],
              },
        ))!;
        const location =
          (n.location as string | undefined) ??
          ((output as Record<string, unknown> | undefined)?.location as
            | string
            | undefined) ??
          env.location;
        const tags = spec.tracked
          ? yield* desiredTags(id, n.tags as Record<string, string> | undefined)
          : {};
        const get = spec.get(subscriptionId, path);

        // Observe.
        let observed = yield* get;
        const body = spec.body(news, {
          subscriptionId,
          path,
          location,
          tags,
          observed,
        });
        const { location: _l, tags: _t, ...comparable } = body as NetworkBody;
        const drifted =
          observed === undefined ||
          // A resource left `Failed` (e.g. by a dependency that was still
          // provisioning) converges by re-applying the PUT.
          observed.properties?.provisioningState === "Failed" ||
          (spec.writeOnlyChanged?.(news, olds) ?? false) ||
          (spec.drifted
            ? spec.drifted(observed, body, news)
            : subsetDiffers(comparable, observed));
        const tagDrift =
          spec.tracked &&
          observed !== undefined &&
          tagsDiffer(observed.tags, tags);

        // Ensure + sync. A PUT that ends `Failed` is re-applied (bounded).
        const put = spec
          .put(subscriptionId, path, body)
          .pipe(Effect.retry(whileNetworkBusy));
        if (drifted || (tagDrift && spec.updateTags === undefined)) {
          observed = yield* put.pipe(
            Effect.andThen(waitReady(describe(path), get)),
            Effect.retry({
              while: (e: { readonly _tag?: string }) =>
                e._tag === "Azure.ProvisioningFailed",
              schedule: Schedule.spaced("10 seconds"),
              times: 2,
            }),
          );
        } else {
          if (tagDrift) {
            yield* spec.updateTags!(subscriptionId, path, tags).pipe(
              Effect.retry(whileNetworkBusy),
            );
          }
          observed = yield* waitReady(describe(path), get);
        }
        return spec.toAttrs(path, observed);
      }),

      delete: Effect.fn(function* ({ output }: { output: Res["Attributes"] }) {
        const { subscriptionId } = yield* AzureEnvironment.current;
        const o = output as Record<string, unknown>;
        const path: Record<string, string> = {
          resourceGroup: o.resourceGroup as string,
          name: o[spec.nameAttr] as string,
        };
        for (const parent of parents) path[parent] = o[parent] as string;
        if (spec.beforeDelete !== undefined) {
          yield* spec.beforeDelete(subscriptionId, path as NetworkPath);
        }
        const deleteOnce = ignoreNotFound(
          spec.del(subscriptionId, path as NetworkPath),
        ).pipe(
          // `CannotDeleteResource`: nested children are still being removed.
          // Slow resources (hubs, gateways) can hold `NetworkOperationInProgress`
          // for the rest of an interrupted 15-30 minute provisioning.
          Effect.retry({
            ...whileInUse(["CannotDeleteResource", ...(spec.inUseTags ?? [])]),
            ...(spec.slow
              ? { schedule: Schedule.spaced("15 seconds"), times: 120 }
              : {}),
          }),
        );
        yield* deleteOnce;
        if (spec.goneWithParent) return;
        // A delete that ends `Failed` leaves the resource in place (seen on
        // hub NVAs, where a second DELETE succeeds): re-issue it.
        yield* waitGone(
          describe(path as NetworkPath),
          spec
            .get(subscriptionId, path as NetworkPath)
            .pipe(
              Effect.tap((observed) =>
                observed?.properties?.provisioningState === "Failed"
                  ? deleteOnce
                  : Effect.void,
              ),
            ),
        );
      }),

      nuke: {
        dependsOn: [...(spec.dependsOn ?? []), "Azure.Resources.ResourceGroup"],
      },
    };
  };

/** `{ id }` references from ARM IDs (`undefined` when none). */
export const refs = (ids: ReadonlyArray<string> | undefined) =>
  ids?.map((id) => ({ id }));

/** ARM IDs from `{ id }` references. */
export const idsOf = (
  items: ReadonlyArray<{ readonly id?: string }> | undefined,
): string[] =>
  (items ?? []).flatMap((item) => (item.id === undefined ? [] : [item.id]));
