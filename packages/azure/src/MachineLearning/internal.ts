import type { AzureOpContext, AzureOpError } from "@distilled.cloud/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  stackAndStage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
  type WaitBudget,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import {
  armTags,
  containsValue,
  createChildName,
  inputFields,
  sameArm,
  sameValue,
} from "./Common.ts";

/*
 * Shared, un-exported helpers for the versioned asset resources (code,
 * components, data, environments, feature sets, feature store entities,
 * models). Not re-exported from `index.ts` except for the prop and
 * attribute types.
 */

/** Where an asset lives: a workspace or a registry. */
export interface AssetParentProps {
  /**
   * Resource group of the workspace or registry. Changing it replaces the
   * asset.
   */
  resourceGroup: string;
  /**
   * Workspace that owns the asset. Set exactly one of `workspace` and
   * `registry`. Changing it replaces the asset.
   */
  workspace?: string;
  /**
   * Registry that owns the asset, to share it across workspaces and
   * regions. Set exactly one of `workspace` and `registry`. Changing it
   * replaces the asset.
   */
  registry?: string;
}

export interface AssetContainerProps extends AssetParentProps {
  /**
   * Asset name: letters, digits, `-`, `_`, and `.`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the asset.
   */
  name?: string;
  /** Description of the asset. */
  description?: string;
  /** Asset property dictionary (string key-value pairs). */
  properties?: Record<string, string>;
  /**
   * User tags (stored in the asset body). Alchemy ownership tags are merged
   * in automatically.
   */
  tags?: Record<string, string>;
  /**
   * Archive the asset (hide it from default lists without deleting it).
   * @default false
   */
  isArchived?: boolean;
}

export interface AssetContainerAttributes {
  /** Name of the asset. */
  containerName: string;
  /** ARM resource ID of the asset container. */
  containerId: string;
  /** Resource group of the workspace or registry. */
  resourceGroup: string;
  /** Workspace that owns the asset, if any. */
  workspace: string | undefined;
  /** Registry that owns the asset, if any. */
  registry: string | undefined;
  /** Description of the asset. */
  description: string | undefined;
  /** Whether the asset is archived. */
  isArchived: boolean;
  /** Latest version registered under the asset. */
  latestVersion: string | undefined;
  /** Next auto-incremented version. */
  nextVersion: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

export interface AssetVersionProps extends AssetParentProps {
  /**
   * Asset (container) name the version belongs to. Azure creates the
   * container if it does not exist. Changing it replaces the version.
   */
  name: string;
  /**
   * Version identifier. Changing it replaces the version.
   * @default "1"
   */
  version?: string;
  /** Description of the version. */
  description?: string;
  /**
   * Asset property dictionary (string key-value pairs). Versions are
   * immutable, so changing it replaces the version.
   */
  properties?: Record<string, string>;
  /**
   * User tags (stored in the version body). Alchemy ownership tags are
   * merged in automatically.
   */
  tags?: Record<string, string>;
  /**
   * Archive the version (hide it from default lists without deleting it).
   * @default false
   */
  isArchived?: boolean;
}

export interface AssetVersionAttributes {
  /** Asset (container) name. */
  name: string;
  /** Version identifier. */
  version: string;
  /** ARM resource ID of the version. */
  versionId: string;
  /** Resource group of the workspace or registry. */
  resourceGroup: string;
  /** Workspace that owns the version, if any. */
  workspace: string | undefined;
  /** Registry that owns the version, if any. */
  registry: string | undefined;
  /** Description of the version. */
  description: string | undefined;
  /** Whether the version is archived. */
  isArchived: boolean;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

export class InvalidAssetParent extends Data.TaggedError(
  "Azure.MachineLearning.InvalidAssetParent",
)<{
  readonly message: string;
}> {}

/** The ARM path parameters of an asset container. */
export type AssetScope = {
  subscriptionId: string;
  resourceGroupName: string;
  name: string;
} & (
  | { workspaceName: string; registryName?: undefined }
  | { registryName: string; workspaceName?: undefined }
);

/** The ARM path parameters of an asset version. */
export type AssetVersionScope = AssetScope & { version: string };

export interface AssetKindOptions {
  /** Feature sets and feature store entities live only in workspaces. */
  workspaceOnly?: boolean;
  /** Code containers are only addressable in registries. */
  registryOnly?: boolean;
  /**
   * Azure rejects deleting this kind in a workspace (only archiving), so
   * `delete` archives it; the workspace's deletion removes it.
   */
  archiveInWorkspace?: boolean;
  /**
   * Azure rejects Alchemy's ownership tags on this kind in a workspace:
   * feature store containers take no tags, feature store versions take at
   * most 3 with keys of letters, digits, `.`, `-`, and `_`, and model
   * containers drop them. Alchemy sends only the user tags there (none for
   * containers), and the parent workspace's stack/stage tags mark ownership.
   */
  untaggedInWorkspace?: boolean;
  /** Kind-specific container props that replace the container when changed. */
  immutableProps?: readonly string[];
}

/**
 * The scope of an asset in exactly one workspace or registry.
 * `workspaceOnly` kinds (feature sets, feature store entities) reject a
 * registry.
 */
export const assetScope = (
  subscriptionId: string,
  parent: AssetParentProps,
  name: string,
  options: AssetKindOptions = {},
): Effect.Effect<AssetScope, InvalidAssetParent> => {
  const base = { subscriptionId, resourceGroupName: parent.resourceGroup, name };
  if (parent.workspace !== undefined && parent.registry === undefined && !options.registryOnly) {
    return Effect.succeed({ ...base, workspaceName: parent.workspace });
  }
  if (parent.registry !== undefined && parent.workspace === undefined && !options.workspaceOnly) {
    return Effect.succeed({ ...base, registryName: parent.registry });
  }
  return Effect.fail(
    new InvalidAssetParent({
      message: options.workspaceOnly
        ? `Set 'workspace' for machine learning asset '${name}'`
        : options.registryOnly
          ? `Set 'registry' for machine learning asset '${name}'`
          : `Set exactly one of 'workspace' and 'registry' for machine learning asset '${name}'`,
    }),
  );
};

/**
 * Path parameters of a workspace-only asset (feature sets, feature store
 * entities); `assetScope` rejects a registry for these kinds.
 */
export const workspacePath = (s: AssetScope) => ({
  subscriptionId: s.subscriptionId,
  resourceGroupName: s.resourceGroupName,
  workspaceName: s.workspaceName ?? "",
  name: s.name,
});

/** Whether persisted props name a resource group and a workspace or registry. */
const hasParent = <T extends AssetParentProps>(props: T | undefined): props is T =>
  props !== undefined &&
  typeof props.resourceGroup === "string" &&
  (typeof props.workspace === "string" || typeof props.registry === "string");

/** Path parameters of a registry-only asset (code containers). */
export const registryPath = (s: AssetScope) => ({
  subscriptionId: s.subscriptionId,
  resourceGroupName: s.resourceGroupName,
  registryName: s.registryName ?? "",
});

/** The scope of an existing asset from its attributes. */
export const scopeOf = (
  subscriptionId: string,
  output: { resourceGroup: string; workspace: string | undefined; registry: string | undefined },
  name: string,
): AssetScope =>
  output.registry !== undefined
    ? {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        name,
        registryName: output.registry,
      }
    : {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        name,
        workspaceName: output.workspace ?? "",
      };

/** Whether the resource group, workspace, or registry changed. */
export const parentChanged = (
  news: AssetParentProps,
  output: { resourceGroup: string; workspace: string | undefined; registry: string | undefined },
) =>
  !sameArm(news.resourceGroup, output.resourceGroup) ||
  !sameArm(news.workspace, output.workspace) ||
  !sameArm(news.registry, output.registry);

type AzureEffect<A> = Effect.Effect<A, AzureOpError, AzureOpContext>;

/** The shape every asset container and version GET returns. */
export interface ObservedAsset {
  id?: string;
  properties: {
    description?: string | null;
    properties?: { [key: string]: string | null | undefined } | null;
    tags?: { [key: string]: string | null | undefined } | null;
    isArchived?: boolean;
    latestVersion?: string | null;
    nextVersion?: string | null;
    stage?: string | null;
    provisioningState?: string;
  };
}

/** The mutable part of an asset body (sent on every PUT). */
export interface AssetBody {
  description?: string;
  properties?: Record<string, string>;
  /** User tags plus the Alchemy ownership tags; omitted for untagged kinds. */
  tags?: Record<string, string>;
  isArchived?: boolean;
  stage?: string;
}

/**
 * Registry assets are long-running operations replicated to every
 * registry region; workspace assets are written synchronously.
 */
const budgetOf = (scope: AssetScope): WaitBudget =>
  scope.registryName !== undefined
    ? { interval: "5 seconds", times: 36 }
    : { interval: "2 seconds", times: 15 };

const mutableDiffers = (observed: ObservedAsset, desired: AssetBody) =>
  (observed.properties.description ?? "") !== (desired.description ?? "") ||
  (desired.tags !== undefined && tagsDiffer(armTags(observed.properties.tags), desired.tags)) ||
  (observed.properties.isArchived ?? false) !== (desired.isArchived ?? false) ||
  (desired.stage !== undefined && observed.properties.stage !== desired.stage) ||
  !containsValue(armTags(observed.properties.properties) ?? {}, desired.properties);

/**
 * Observe → ensure → sync an asset container or version: PUT when it is
 * missing or its description, tags, archive flag, stage, or properties
 * drifted (the PUT body always carries the full desired state), then wait
 * until Azure reports it provisioned.
 */
export const reconcileAsset = Effect.fn(function* (args: {
  label: string;
  scope: AssetScope;
  get: AzureEffect<ObservedAsset | undefined>;
  put: (body: AssetBody) => AzureEffect<unknown>;
  desired: AssetBody;
}) {
  yield* ensureRegistered(args.scope.subscriptionId, "Microsoft.MachineLearningServices");
  const get = orUndefinedIfNotFound(args.get);

  // Observe.
  const observed = yield* get;

  // Ensure + sync.
  const wrote = observed === undefined || mutableDiffers(observed, args.desired);
  if (wrote) {
    yield* args.put(args.desired);
  }

  // GET can return the previous body for a few seconds after a PUT, so
  // wait until it reflects the write.
  return yield* waitForProvisioned(
    args.label,
    get,
    (asset) => {
      const state = asset.properties.provisioningState;
      if (state !== undefined && state !== "Succeeded") return state;
      return wrote && mutableDiffers(asset, args.desired) ? "Updating" : "Succeeded";
    },
    budgetOf(args.scope),
  );
});

/** Read an asset and whether this stack/stage/id owns it. */
export const observeAsset = Effect.fn(function* (
  id: string,
  get: AzureEffect<ObservedAsset | undefined>,
) {
  const observed = yield* orUndefinedIfNotFound(get);
  if (observed === undefined) return undefined;
  const owned = yield* isOwned(id, armTags(observed.properties.tags));
  return { observed, owned };
});

/**
 * Whether this stack/stage owns the workspace an untagged asset lives in
 * (its own ownership marker when the asset cannot carry tags).
 */
const workspaceOwned = Effect.fn(function* (scope: AssetScope) {
  if (scope.workspaceName === undefined) return false;
  const workspace = yield* orUndefinedIfNotFound(
    ml.GetWorkspace({
      subscriptionId: scope.subscriptionId,
      resourceGroupName: scope.resourceGroupName,
      workspaceName: scope.workspaceName,
    }),
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    workspace?.tags?.["alchemy::stack"] === stack && workspace?.tags?.["alchemy::stage"] === stage
  );
});

/** Delete an asset (idempotent) and wait until it is gone. */
export const deleteAsset = Effect.fn(function* (args: {
  label: string;
  scope: AssetScope;
  get: AzureEffect<ObservedAsset | undefined>;
  delete: AzureEffect<unknown>;
}) {
  yield* ignoreNotFound(args.delete);
  yield* waitUntilGone(args.label, orUndefinedIfNotFound(args.get), budgetOf(args.scope));
});

/**
 * Archive an asset Azure refuses to delete (PUT the last desired body with
 * `isArchived: true`). Missing or already archived assets are left alone.
 */
const archiveAsset = Effect.fn(function* (
  get: AzureEffect<ObservedAsset | undefined>,
  put: (body: AssetBody) => AzureEffect<unknown>,
  body: AssetBody,
) {
  const observed = yield* orUndefinedIfNotFound(get);
  if (observed === undefined || observed.properties.isArchived === true) return;
  yield* put(body);
});

const parentAttrs = (scope: AssetScope) => ({
  resourceGroup: scope.resourceGroupName,
  workspace: scope.workspaceName,
  registry: scope.registryName,
});

export const containerAttrs = (
  scope: AssetScope,
  observed: ObservedAsset,
): AssetContainerAttributes => ({
  containerName: scope.name,
  containerId: observed.id ?? "",
  ...parentAttrs(scope),
  description: observed.properties.description ?? undefined,
  isArchived: observed.properties.isArchived ?? false,
  latestVersion: observed.properties.latestVersion ?? undefined,
  nextVersion: observed.properties.nextVersion ?? undefined,
  tags: userTags(armTags(observed.properties.tags)),
});

export const versionAttrs = (
  scope: AssetVersionScope,
  observed: ObservedAsset,
): AssetVersionAttributes => ({
  name: scope.name,
  version: scope.version,
  versionId: observed.id ?? "",
  ...parentAttrs(scope),
  description: observed.properties.description ?? undefined,
  isArchived: observed.properties.isArchived ?? false,
  tags: userTags(armTags(observed.properties.tags)),
});

/** Containers and versions are deleted with their workspace or registry. */
const ASSET_NUKE = {
  dependsOn: ["Azure.MachineLearning.Workspace", "Azure.MachineLearning.Registry"],
};

export interface ContainerOps<P = AssetContainerProps> {
  get: (scope: AssetScope) => AzureEffect<ObservedAsset>;
  /** PUT the container body: the mutable `body` plus any kind-specific fields from `news`. */
  put: (scope: AssetScope, body: AssetBody, news: P) => AzureEffect<unknown>;
  delete: (scope: AssetScope) => AzureEffect<unknown>;
}

const CONTAINER_STABLES: Extract<keyof AssetContainerAttributes, string>[] = [
  "containerName",
  "containerId",
  "resourceGroup",
  "workspace",
  "registry",
];

/**
 * The lifecycle shared by every asset container: identity (group, parent,
 * name) replaces; description, properties, tags, and the archive flag
 * update in place.
 */
export const containerProvider = <P extends AssetContainerProps>(
  label: string,
  ops: ContainerOps<P>,
  options: AssetKindOptions = {},
) => {
  const untagged = (scope: AssetScope) =>
    options.untaggedInWorkspace === true && scope.workspaceName !== undefined;
  const tagsFor = (id: string, scope: AssetScope, tags: Record<string, string> | undefined) =>
    untagged(scope) ? Effect.succeed(undefined) : desiredTags(id, tags);
  return {
    stables: CONTAINER_STABLES,

    // Containers are deleted with their workspace or registry.
    list: Effect.fn(function* () {
      const none: AssetContainerAttributes[] = [];
      return none;
    }),

    diff: Effect.fn(function* ({
      news,
      olds,
      output,
    }: {
      news: Input<AssetContainerProps>;
      olds: AssetContainerProps | undefined;
      output: AssetContainerAttributes | undefined;
    }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the parent
      // is being replaced.
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace) ||
        !isResolved(fields.registry) ||
        !isResolved(fields.name)
      ) {
        return { action: "replace" } as const;
      }
      if (
        !sameArm(fields.resourceGroup, output.resourceGroup) ||
        !sameArm(fields.workspace, output.workspace) ||
        !sameArm(fields.registry, output.registry) ||
        (fields.name !== undefined && fields.name !== output.containerName)
      ) {
        return { action: "replace" } as const;
      }
      const immutable = options.immutableProps ?? [];
      if (immutable.length > 0 && olds !== undefined) {
        if (!isResolved(news)) return { action: "replace" } as const;
        const pick = (props: object) =>
          Object.fromEntries(Object.entries(props).filter(([key]) => immutable.includes(key)));
        if (!sameValue(pick(news), pick(olds))) return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({
      id,
      olds,
      output,
    }: {
      id: string;
      olds: AssetContainerProps | undefined;
      output: AssetContainerAttributes | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output?.containerName ?? olds?.name ?? (yield* createChildName(id, 64));
      let scope: AssetScope;
      if (output !== undefined) {
        scope = scopeOf(subscriptionId, output, name);
      } else if (hasParent(olds)) {
        scope = yield* assetScope(subscriptionId, olds, name, options);
      } else {
        // No state, or props persisted before their parent resolved.
        return undefined;
      }
      const found = yield* observeAsset(id, ops.get(scope));
      if (found === undefined) return undefined;
      const attrs = containerAttrs(scope, found.observed);
      const owned = untagged(scope) ? yield* workspaceOwned(scope) : found.owned;
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({
      id,
      news,
      output,
    }: {
      id: string;
      news: P;
      output: AssetContainerAttributes | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = news.name ?? output?.containerName ?? (yield* createChildName(id, 64));
      const scope = yield* assetScope(subscriptionId, news, name, options);
      const tags = yield* tagsFor(id, scope, news.tags);
      const observed = yield* reconcileAsset({
        label: `machine learning ${label} ${name}`,
        scope,
        get: ops.get(scope),
        put: (body) => ops.put(scope, body, news),
        desired: {
          description: news.description,
          properties: news.properties,
          tags,
          isArchived: news.isArchived,
        },
      });
      return containerAttrs(scope, observed);
    }),

    delete: Effect.fn(function* ({
      id,
      olds,
      output,
    }: {
      id: string;
      olds: P | undefined;
      output: AssetContainerAttributes;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope = scopeOf(subscriptionId, output, output.containerName);
      if (options.archiveInWorkspace && scope.workspaceName !== undefined && olds !== undefined) {
        const tags = yield* tagsFor(id, scope, olds.tags);
        return yield* archiveAsset(ops.get(scope), (body) => ops.put(scope, body, olds), {
          description: olds.description,
          properties: olds.properties,
          tags,
          isArchived: true,
        });
      }
      yield* deleteAsset({
        label: `machine learning ${label} ${output.containerName}`,
        scope,
        get: ops.get(scope),
        delete: ops.delete(scope),
      });
    }),

    nuke: ASSET_NUKE,
  };
};

export interface VersionOps<P> {
  get: (scope: AssetVersionScope) => AzureEffect<ObservedAsset>;
  /** PUT the full version body: the mutable `body` plus the content from `news`. */
  put: (scope: AssetVersionScope, body: AssetBody, news: P) => AzureEffect<unknown>;
  delete: (scope: AssetVersionScope) => AzureEffect<unknown>;
  /** The version's lifecycle stage, for kinds that have one (updated in place). */
  stageOf?: (news: P) => string | undefined;
}

const VERSION_STABLES: Extract<keyof AssetVersionAttributes, string>[] = [
  "name",
  "version",
  "versionId",
  "resourceGroup",
  "workspace",
  "registry",
];

/**
 * Azure answers every request for a deleted asset version (environment
 * versions) with `MachineLearningAssetVersionDeleted`: it is gone.
 */
const unlessDeleted = <A>(effect: AzureEffect<A>) =>
  Effect.catchTag(effect, "MachineLearningAssetVersionDeleted", () => Effect.succeed(undefined));

/** Props a version can change in place; everything else is immutable content. */
const MUTABLE_VERSION_PROPS = new Set(["description", "tags", "isArchived", "stage"]);

const immutablePart = (props: object) =>
  Object.fromEntries(Object.entries(props).filter(([key]) => !MUTABLE_VERSION_PROPS.has(key)));

/**
 * The lifecycle shared by every asset version. Azure asset versions are
 * immutable: identity (group, parent, name, version) and content replace;
 * description, tags, the archive flag, and the stage update in place. A
 * content change at the same identity deletes the old version first (the
 * new one reuses its name and version).
 */
export const versionProvider = <P extends AssetVersionProps>(
  label: string,
  ops: VersionOps<P>,
  options: AssetKindOptions = {},
) => {
  const untagged = (scope: AssetScope) =>
    options.untaggedInWorkspace === true && scope.workspaceName !== undefined;
  const tagsFor = (id: string, scope: AssetScope, tags: Record<string, string> | undefined) =>
    untagged(scope) ? Effect.succeed(tags ?? {}) : desiredTags(id, tags);
  return {
    stables: VERSION_STABLES,

    // Versions are deleted with their workspace or registry.
    list: Effect.fn(function* () {
      const none: AssetVersionAttributes[] = [];
      return none;
    }),

    diff: Effect.fn(function* ({
      news,
      olds,
      output,
    }: {
      news: Input<AssetVersionProps>;
      olds: AssetVersionProps | undefined;
      output: AssetVersionAttributes | undefined;
    }) {
      if (output === undefined) return undefined;
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace) ||
        !isResolved(fields.registry) ||
        !isResolved(fields.name) ||
        !isResolved(fields.version)
      ) {
        return { action: "replace" } as const;
      }
      if (
        !sameArm(fields.resourceGroup, output.resourceGroup) ||
        !sameArm(fields.workspace, output.workspace) ||
        !sameArm(fields.registry, output.registry) ||
        fields.name !== output.name ||
        (fields.version ?? "1") !== output.version
      ) {
        return { action: "replace" } as const;
      }
      // Same identity: new content must delete the old version first.
      if (!isResolved(news)) return { action: "replace", deleteFirst: true } as const;
      if (olds !== undefined && !sameValue(immutablePart(news), immutablePart(olds))) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({
      id,
      olds,
      output,
    }: {
      id: string;
      olds: AssetVersionProps | undefined;
      output: AssetVersionAttributes | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      let scope: AssetVersionScope;
      if (output !== undefined) {
        scope = { ...scopeOf(subscriptionId, output, output.name), version: output.version };
      } else if (hasParent(olds) && olds.name !== undefined) {
        const base = yield* assetScope(subscriptionId, olds, olds.name, options);
        scope = { ...base, version: olds.version ?? "1" };
      } else {
        // No state, or props persisted before their parent resolved.
        return undefined;
      }
      const found = yield* observeAsset(id, unlessDeleted(ops.get(scope)));
      if (found === undefined) return undefined;
      const attrs = versionAttrs(scope, found.observed);
      const owned = untagged(scope) ? yield* workspaceOwned(scope) : found.owned;
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }: { id: string; news: P }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const base = yield* assetScope(subscriptionId, news, news.name, options);
      const scope: AssetVersionScope = { ...base, version: news.version ?? "1" };
      const tags = yield* tagsFor(id, scope, news.tags);
      const observed = yield* reconcileAsset({
        label: `machine learning ${label} ${news.name}:${scope.version}`,
        scope,
        get: unlessDeleted(ops.get(scope)),
        put: (body) => ops.put(scope, body, news),
        desired: {
          description: news.description,
          properties: news.properties,
          tags,
          isArchived: news.isArchived,
          stage: ops.stageOf?.(news),
        },
      });
      return versionAttrs(scope, observed);
    }),

    delete: Effect.fn(function* ({
      id,
      olds,
      output,
    }: {
      id: string;
      olds: P | undefined;
      output: AssetVersionAttributes;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope: AssetVersionScope = {
        ...scopeOf(subscriptionId, output, output.name),
        version: output.version,
      };
      if (options.archiveInWorkspace && scope.workspaceName !== undefined && olds !== undefined) {
        const tags = yield* tagsFor(id, scope, olds.tags);
        return yield* archiveAsset(
          unlessDeleted(ops.get(scope)),
          (body) => ops.put(scope, body, olds),
          {
            description: olds.description,
            properties: olds.properties,
            tags,
            isArchived: true,
            stage: ops.stageOf?.(olds),
          },
        );
      }
      yield* deleteAsset({
        label: `machine learning ${label} ${output.name}:${output.version}`,
        scope,
        get: unlessDeleted(ops.get(scope)),
        delete: unlessDeleted(ops.delete(scope)),
      });
    }),

    nuke: ASSET_NUKE,
  };
};
