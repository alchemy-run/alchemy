import type * as workers from "@distilled.cloud/cloudflare/workers";

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

export interface DurableObjectExportState {
  tombstones: Record<string, DurableObjectTombstone>;
  pendingTransfers: string[];
}

export interface DurableObjectNamespace {
  script: string;
  className: string;
  storage: DurableObjectStorage;
}

export interface DurableObjectExportClass {
  className: string;
  previousClassName?: string;
  transferFrom?: string;
  storage?: DurableObjectStorage;
}

export interface BuildDurableObjectExportsInput {
  scriptName: string;
  classes: readonly DurableObjectExportClass[];
  deletedClasses: readonly string[];
  transferredClasses: ReadonlyArray<{
    className: string;
    transferredTo: string;
  }>;
  containerClassNames: ReadonlySet<string>;
  namespaces: readonly DurableObjectNamespace[];
  previousState?: DurableObjectExportState;
}

export interface DurableObjectExportPlan {
  exports: workers.PutScriptExports | undefined;
  changedClasses: string[];
}

const storageFor = (
  namespaces: readonly DurableObjectNamespace[],
  scriptName: string,
  ...classNames: Array<string | undefined>
): DurableObjectStorage =>
  namespaces.find(
    (namespace) =>
      namespace.script === scriptName &&
      classNames.some((className) => className === namespace.className),
  )?.storage ?? "sqlite";

const liveExport = (
  storage: DurableObjectStorage,
  container: string | undefined,
): workers.PutScriptDurableObjectLiveExport => ({
  type: "durable-object",
  storage,
  container,
});

/**
 * Build the complete declarative Durable Object export map for one Worker.
 * Existing tombstones remain until Cloudflare reports them as removable.
 */
export const buildDurableObjectExports = ({
  scriptName,
  classes,
  deletedClasses,
  transferredClasses,
  containerClassNames,
  namespaces,
  previousState,
}: BuildDurableObjectExportsInput): DurableObjectExportPlan => {
  const exports: workers.PutScriptExports = {
    ...(previousState?.tombstones ?? {}),
  };
  const changedClasses = new Set<string>();

  for (const current of classes) {
    const container = containerClassNames.has(current.className)
      ? current.className
      : undefined;
    const storage =
      current.storage ??
      storageFor(
        namespaces,
        scriptName,
        current.className,
        current.previousClassName,
      );

    if (
      current.previousClassName !== undefined &&
      current.previousClassName !== current.className
    ) {
      exports[current.previousClassName] = {
        type: "durable-object",
        state: "renamed",
        renamedTo: current.className,
      };
      changedClasses.add(current.previousClassName);
      changedClasses.add(current.className);
    }

    exports[current.className] =
      current.transferFrom === undefined
        ? liveExport(storage, container)
        : {
            type: "durable-object",
            state: "expecting-transfer",
            storage,
            transferFrom: current.transferFrom,
            container,
          };
    if (current.transferFrom !== undefined) {
      changedClasses.add(current.className);
    } else if (current.previousClassName === undefined) {
      changedClasses.add(current.className);
    }
  }

  for (const className of deletedClasses) {
    exports[className] = { type: "durable-object", state: "deleted" };
    changedClasses.add(className);
  }

  for (const transfer of transferredClasses) {
    exports[transfer.className] = {
      type: "durable-object",
      state: "transferred",
      transferredTo: transfer.transferredTo,
    };
    changedClasses.add(transfer.className);
  }

  return {
    exports: Object.keys(exports).length > 0 ? exports : undefined,
    changedClasses: [...changedClasses],
  };
};

export const nextDurableObjectExportState = (
  submitted: workers.PutScriptExports | undefined,
  reconciliation: workers.PutScriptExportsReconciliation | null | undefined,
): DurableObjectExportState | undefined => {
  if (submitted === undefined) return undefined;
  const removable = new Set(reconciliation?.removableEntries ?? []);
  const tombstones: Record<string, DurableObjectTombstone> = {};
  for (const [className, entry] of Object.entries(submitted)) {
    if (
      entry === undefined ||
      removable.has(className) ||
      entry.type !== "durable-object"
    ) {
      continue;
    }
    if (entry.state === "deleted") {
      tombstones[className] = { type: "durable-object", state: "deleted" };
      continue;
    }
    if (
      entry.state === "renamed" &&
      "renamedTo" in entry &&
      typeof entry.renamedTo === "string"
    ) {
      tombstones[className] = {
        type: "durable-object",
        state: "renamed",
        renamedTo: entry.renamedTo,
      };
      continue;
    }
    if (
      entry.state === "transferred" &&
      "transferredTo" in entry &&
      typeof entry.transferredTo === "string"
    ) {
      tombstones[className] = {
        type: "durable-object",
        state: "transferred",
        transferredTo: entry.transferredTo,
      };
    }
  }
  const pendingTransfers =
    reconciliation === undefined || reconciliation === null
      ? Object.entries(submitted).flatMap(([className, entry]) =>
          entry?.type === "durable-object" &&
          entry.state === "expecting-transfer"
            ? [className]
            : [],
        )
      : reconciliation.transferPending.map((transfer) => transfer.class);

  return Object.keys(tombstones).length > 0 || pendingTransfers.length > 0
    ? { tombstones, pendingTransfers }
    : undefined;
};
