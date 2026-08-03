import type * as workers from "@distilled.cloud/cloudflare/workers";
import type * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

export type DurableObjectStorage = "sqlite" | "legacy-kv";

export type DurableObjectTombstone =
  | {
      type: "durable-object";
      state: "deleted";
    }
  | {
      type: "durable-object";
      state: "renamed";
      renamedTo: string;
    }
  | {
      type: "durable-object";
      state: "transferred";
      transferredTo: string;
    };

export interface DurableObjectPendingTransfer {
  transferFrom: string;
  storage: DurableObjectStorage;
  container?: string;
}

export interface DurableObjectExportState {
  tombstones: Record<string, DurableObjectTombstone>;
  pendingTransfers: Record<string, DurableObjectPendingTransfer>;
  storageByClass: Record<string, DurableObjectStorage>;
  cleanupClassNames: string[];
}

export interface DurableObjectNamespace {
  script: string;
  className: string;
  storage: DurableObjectStorage;
}

export type DurableObjectClassObservation =
  | { kind: "new"; className: string }
  | {
      kind: "existing";
      className: string;
      previousClassName: string;
    }
  | {
      kind: "incoming-transfer";
      className: string;
      transferFrom: string;
    };

export type DurableObjectRetirement =
  | { kind: "deleted" }
  | { kind: "transferred"; transferredTo: string };

export type DurableObjectExportDirective =
  | {
      kind: "live";
      storage: DurableObjectStorage;
      container?: string;
      changed: boolean;
    }
  | {
      kind: "deleted";
    }
  | {
      kind: "renamed";
      renamedTo: string;
    }
  | {
      kind: "transferred";
      transferredTo: string;
    }
  | {
      kind: "expecting-transfer";
      transferFrom: string;
      storage: DurableObjectStorage;
      container?: string;
    };

export interface PlanDurableObjectExportsInput {
  scriptName: string;
  classes: readonly DurableObjectClassObservation[];
  retirements: Readonly<Record<string, DurableObjectRetirement>>;
  containerClassNames: ReadonlySet<string>;
  namespaces: readonly DurableObjectNamespace[];
  observedStorageByClass: Readonly<Record<string, DurableObjectStorage>>;
  observedPendingTransfers: Readonly<
    Record<string, DurableObjectPendingTransfer>
  >;
  previousState?: DurableObjectExportState;
}

export interface DurableObjectExportPlan {
  exports: workers.PutScriptExports | undefined;
  changedClasses: string[];
  omittedBindingClassNames: ReadonlySet<string>;
}

export class DurableObjectStorageUnknown extends Data.TaggedError(
  "DurableObjectStorageUnknown",
)<{
  scriptName: string;
  className: string;
}> {
  override get message() {
    return `Durable Object class '${this.className}' already exists on Worker '${this.scriptName}', but Cloudflare did not report whether its immutable storage backend is SQLite or legacy KV. Alchemy did not upload a guessed storage value. Retry after the Worker settings API reports the class export, or declare the class with a Cloudflare client that can preserve its current storage backend.`;
  }
}

export class ConflictingDurableObjectExports extends Data.TaggedError(
  "ConflictingDurableObjectExports",
)<{
  scriptName: string;
  className: string;
  current: DurableObjectExportDirective;
  next: DurableObjectExportDirective;
}> {
  override get message() {
    return `Durable Object class '${this.className}' has conflicting lifecycle declarations on Worker '${this.scriptName}'. Give each hosted class one lifecycle identity before deploying.`;
  }
}

export class DurableObjectPendingTransferRename extends Data.TaggedError(
  "DurableObjectPendingTransferRename",
)<{
  scriptName: string;
  previousClassName: string;
  className: string;
}> {
  override get message() {
    return `Durable Object class '${this.previousClassName}' on Worker '${this.scriptName}' is still waiting for a namespace transfer and cannot be renamed to '${this.className}' yet. Deploy the transfer with class '${this.previousClassName}' until it completes, then rename it in a later deploy.`;
  }
}

export type DurableObjectExportPlanResult =
  | { _tag: "Success"; plan: DurableObjectExportPlan }
  | {
      _tag: "Failure";
      error:
        | DurableObjectStorageUnknown
        | ConflictingDurableObjectExports
        | DurableObjectPendingTransferRename;
    };

export interface ObservedDurableObjectExports {
  storageByClass: Record<string, DurableObjectStorage>;
  pendingTransfers: Record<string, DurableObjectPendingTransfer>;
}

export const recoverDurableObjectExportState = (
  tagged: DurableObjectExportState | undefined,
  persisted: DurableObjectExportState | undefined,
): DurableObjectExportState | undefined => {
  if (tagged === undefined) return persisted;
  const cleanupClassNames = persisted?.cleanupClassNames ?? [];
  const cleanup = new Set(cleanupClassNames);
  return {
    tombstones: Object.fromEntries(
      Object.entries(tagged.tombstones).filter(
        ([className]) => !cleanup.has(className),
      ),
    ),
    pendingTransfers: tagged.pendingTransfers,
    storageByClass: tagged.storageByClass,
    cleanupClassNames,
  };
};

const isStorage = (value: unknown): value is DurableObjectStorage =>
  value === "sqlite" || value === "legacy-kv";

const stringMember = (value: unknown, key: string): string | undefined =>
  Predicate.hasProperty(value, key) && typeof value[key] === "string"
    ? value[key]
    : undefined;

const stringArrayMember = (value: unknown, key: string): string[] =>
  Predicate.hasProperty(value, key) && Array.isArray(value[key])
    ? value[key].filter((item): item is string => typeof item === "string")
    : [];

type SettingsExports =
  | workers.ScriptsScriptAndVersionSettingsGetResponseExportsMap
  | wfp.DispatchNamespacesScriptsSettingsGetResponseExportsMap
  | null
  | undefined;

/**
 * Read the live export state returned by either the regular Worker settings
 * endpoint or the Workers for Platforms settings endpoint.
 */
export const observeDurableObjectExports = (
  value: SettingsExports,
): ObservedDurableObjectExports => {
  const storageByClass: Record<string, DurableObjectStorage> = {};
  const pendingTransfers: Record<string, DurableObjectPendingTransfer> = {};

  for (const [className, entry] of Object.entries(value ?? {})) {
    if (entry?.type !== "durable-object") continue;
    const storage = entry.storage;
    if (!isStorage(storage)) continue;
    storageByClass[className] = storage;

    if (entry.state !== "expecting-transfer") continue;
    const transferFrom = entry.transferFrom ?? undefined;
    if (transferFrom === undefined) continue;
    const container = entry.container ?? undefined;
    pendingTransfers[className] = {
      transferFrom,
      storage,
      ...(container === undefined ? {} : { container }),
    };
  }

  return { storageByClass, pendingTransfers };
};

/**
 * Recover immutable storage backends from legacy migration settings when an
 * older Worker has not yet exposed a declarative live export.
 */
export const observeLegacyDurableObjectStorage = (
  value: unknown,
): Record<string, DurableObjectStorage> => {
  const storageByClass: Record<string, DurableObjectStorage> = {};
  const steps =
    Predicate.hasProperty(value, "steps") && Array.isArray(value.steps)
      ? value.steps
      : [value];

  for (const step of steps) {
    for (const className of stringArrayMember(step, "newClasses")) {
      storageByClass[className] = "legacy-kv";
    }
    for (const className of stringArrayMember(step, "newSqliteClasses")) {
      storageByClass[className] = "sqlite";
    }
    if (
      Predicate.hasProperty(step, "renamedClasses") &&
      Array.isArray(step.renamedClasses)
    ) {
      for (const rename of step.renamedClasses) {
        const from = stringMember(rename, "from");
        const to = stringMember(rename, "to");
        if (from === undefined || to === undefined) continue;
        const storage = storageByClass[from];
        delete storageByClass[from];
        if (storage !== undefined) storageByClass[to] = storage;
      }
    }
    for (const className of stringArrayMember(step, "deletedClasses")) {
      delete storageByClass[className];
    }
  }

  return storageByClass;
};

const directiveEqual = (
  left: DurableObjectExportDirective,
  right: DurableObjectExportDirective,
): boolean => {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "live":
      return (
        right.kind === "live" &&
        left.storage === right.storage &&
        left.container === right.container &&
        left.changed === right.changed
      );
    case "deleted":
      return right.kind === "deleted";
    case "renamed":
      return right.kind === "renamed" && left.renamedTo === right.renamedTo;
    case "transferred":
      return (
        right.kind === "transferred" &&
        left.transferredTo === right.transferredTo
      );
    case "expecting-transfer":
      return (
        right.kind === "expecting-transfer" &&
        left.transferFrom === right.transferFrom &&
        left.storage === right.storage &&
        left.container === right.container
      );
  }
};

const storageFor = (
  namespaces: readonly DurableObjectNamespace[],
  scriptName: string,
  storageByClass: Readonly<Record<string, DurableObjectStorage>>,
  ...classNames: Array<string | undefined>
): DurableObjectStorage | undefined =>
  namespaces.find(
    (namespace) =>
      namespace.script === scriptName &&
      classNames.some((className) => className === namespace.className),
  )?.storage ??
  classNames.flatMap((className) =>
    className === undefined || storageByClass[className] === undefined
      ? []
      : [storageByClass[className]],
  )[0];

const liveExport = (
  storage: DurableObjectStorage,
  container: string | undefined,
): workers.PutScriptDurableObjectLiveExport => ({
  type: "durable-object",
  storage,
  container,
});

/**
 * Build the complete declarative Durable Object export map from observed
 * cloud state and the Worker's current Durable Object declarations.
 */
export const planDurableObjectExports = ({
  scriptName,
  classes,
  retirements,
  containerClassNames,
  namespaces,
  observedStorageByClass,
  observedPendingTransfers,
  previousState,
}: PlanDurableObjectExportsInput): DurableObjectExportPlanResult => {
  const directives: Record<string, DurableObjectExportDirective> = {};
  const storageByClass = {
    ...(previousState?.storageByClass ?? {}),
    ...observedStorageByClass,
  };
  const pendingTransfers = {
    ...(previousState?.pendingTransfers ?? {}),
    ...observedPendingTransfers,
  };

  const addDirective = (
    className: string,
    directive: DurableObjectExportDirective,
  ) => {
    const current = directives[className];
    if (current === undefined || directiveEqual(current, directive)) {
      directives[className] = directive;
      return undefined;
    }
    return new ConflictingDurableObjectExports({
      scriptName,
      className,
      current,
      next: directive,
    });
  };

  for (const [className, retirement] of Object.entries(retirements)) {
    const error = addDirective(
      className,
      retirement.kind === "deleted"
        ? { kind: "deleted" }
        : {
            kind: "transferred",
            transferredTo: retirement.transferredTo,
          },
    );
    if (error !== undefined) return { _tag: "Failure", error };
  }

  for (const current of classes) {
    const container = containerClassNames.has(current.className)
      ? current.className
      : undefined;
    const pendingClassName =
      current.kind === "existing"
        ? current.previousClassName
        : current.className;
    const pending = pendingTransfers[pendingClassName];
    if (pending !== undefined) {
      if (pendingClassName !== current.className) {
        return {
          _tag: "Failure",
          error: new DurableObjectPendingTransferRename({
            scriptName,
            previousClassName: pendingClassName,
            className: current.className,
          }),
        };
      }
      const sourceStillHosts = namespaces.some(
        (namespace) =>
          namespace.script === pending.transferFrom &&
          namespace.className === current.className,
      );
      const error = addDirective(
        current.className,
        sourceStillHosts
          ? {
              kind: "expecting-transfer",
              transferFrom: pending.transferFrom,
              storage: pending.storage,
              container: pending.container ?? container,
            }
          : {
              kind: "live",
              storage: pending.storage,
              container: pending.container ?? container,
              changed: true,
            },
      );
      if (error !== undefined) return { _tag: "Failure", error };
      continue;
    }

    if (current.kind === "existing") {
      const storage = storageFor(
        namespaces,
        scriptName,
        storageByClass,
        current.className,
        current.previousClassName,
      );
      if (storage === undefined) {
        return {
          _tag: "Failure",
          error: new DurableObjectStorageUnknown({
            scriptName,
            className: current.previousClassName,
          }),
        };
      }
      if (current.previousClassName !== current.className) {
        const renameError = addDirective(current.previousClassName, {
          kind: "renamed",
          renamedTo: current.className,
        });
        if (renameError !== undefined) {
          return { _tag: "Failure", error: renameError };
        }
      }
      const liveError = addDirective(current.className, {
        kind: "live",
        storage,
        container,
        changed: current.previousClassName !== current.className,
      });
      if (liveError !== undefined) {
        return { _tag: "Failure", error: liveError };
      }
      continue;
    }

    if (current.kind === "incoming-transfer") {
      const storage = storageFor(
        namespaces,
        current.transferFrom,
        storageByClass,
        current.className,
      );
      if (storage === undefined) {
        return {
          _tag: "Failure",
          error: new DurableObjectStorageUnknown({
            scriptName: current.transferFrom,
            className: current.className,
          }),
        };
      }
      const error = addDirective(current.className, {
        kind: "expecting-transfer",
        transferFrom: current.transferFrom,
        storage,
        container,
      });
      if (error !== undefined) return { _tag: "Failure", error };
      continue;
    }

    const error = addDirective(current.className, {
      kind: "live",
      storage: "sqlite",
      container,
      changed: true,
    });
    if (error !== undefined) return { _tag: "Failure", error };
  }

  const exports: workers.PutScriptExports = Object.fromEntries(
    Object.entries(previousState?.tombstones ?? {}).filter(([, tombstone]) => {
      if (tombstone.state !== "renamed") return true;
      return directives[tombstone.renamedTo]?.kind === "live";
    }),
  );
  const changedClasses = new Set(previousState?.cleanupClassNames ?? []);
  const omittedBindingClassNames = new Set<string>();

  for (const [className, directive] of Object.entries(directives)) {
    switch (directive.kind) {
      case "live":
        exports[className] = liveExport(directive.storage, directive.container);
        if (directive.changed) changedClasses.add(className);
        break;
      case "deleted":
        exports[className] = { type: "durable-object", state: "deleted" };
        changedClasses.add(className);
        break;
      case "renamed":
        exports[className] = {
          type: "durable-object",
          state: "renamed",
          renamedTo: directive.renamedTo,
        };
        changedClasses.add(className);
        changedClasses.add(directive.renamedTo);
        break;
      case "transferred":
        exports[className] = {
          type: "durable-object",
          state: "transferred",
          transferredTo: directive.transferredTo,
        };
        changedClasses.add(className);
        break;
      case "expecting-transfer":
        exports[className] = {
          type: "durable-object",
          state: "expecting-transfer",
          storage: directive.storage,
          transferFrom: directive.transferFrom,
          container: directive.container,
        };
        changedClasses.add(className);
        omittedBindingClassNames.add(className);
        break;
    }
  }

  return {
    _tag: "Success",
    plan: {
      exports: Object.keys(exports).length > 0 ? exports : undefined,
      changedClasses: [...changedClasses],
      omittedBindingClassNames,
    },
  };
};

export const nextDurableObjectExportState = (
  submitted: workers.PutScriptExports | undefined,
  reconciliation: workers.PutScriptExportsReconciliation | null | undefined,
): DurableObjectExportState | undefined => {
  if (submitted === undefined) return undefined;
  const removable = new Set(reconciliation?.removableEntries ?? []);
  const tombstones: Record<string, DurableObjectTombstone> = {};
  const pendingTransfers: Record<string, DurableObjectPendingTransfer> = {};
  const storageByClass: Record<string, DurableObjectStorage> = {};

  for (const [className, entry] of Object.entries(submitted)) {
    if (entry === undefined || entry.type !== "durable-object") continue;
    if (removable.has(className)) continue;
    if (entry.state === "deleted") {
      tombstones[className] = { type: "durable-object", state: "deleted" };
      continue;
    }
    if (entry.state === "renamed" && "renamedTo" in entry) {
      tombstones[className] = {
        type: "durable-object",
        state: "renamed",
        renamedTo: entry.renamedTo,
      };
      continue;
    }
    if (entry.state === "transferred" && "transferredTo" in entry) {
      tombstones[className] = {
        type: "durable-object",
        state: "transferred",
        transferredTo: entry.transferredTo,
      };
      continue;
    }
    if (!("storage" in entry) || !isStorage(entry.storage)) continue;
    storageByClass[className] = entry.storage;
    if (entry.state === "expecting-transfer" && "transferFrom" in entry) {
      pendingTransfers[className] = {
        transferFrom: entry.transferFrom,
        storage: entry.storage,
        ...("container" in entry && typeof entry.container === "string"
          ? { container: entry.container }
          : {}),
      };
    }
  }

  return Object.keys(tombstones).length > 0 ||
    Object.keys(pendingTransfers).length > 0 ||
    Object.keys(storageByClass).length > 0 ||
    removable.size > 0
    ? {
        tombstones,
        pendingTransfers,
        storageByClass,
        cleanupClassNames: [...removable],
      }
    : undefined;
};
