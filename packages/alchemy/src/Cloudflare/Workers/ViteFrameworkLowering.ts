import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ViteFrameworkBuildOutput } from "../../Bundle/Vite.ts";
import type { ResourceBinding } from "../../Resource.ts";
import type { Worker } from "./Worker.ts";
import type { WireWorkerBinding, WorkerBinding } from "./WorkerBinding.ts";

/** A framework contribution collides with an application-owned Worker binding. */
export class ViteFrameworkContributionError extends Data.TaggedError(
  "ViteFrameworkContributionError",
)<{
  bindingName: string;
  reason: string;
}> {
  override get message() {
    return `Framework-contributed Durable Object binding '${this.bindingName}' conflicts with the application Worker: ${this.reason}`;
  }
}

/** @internal Merge flags without changing application-declared order. */
export const mergeCompatibilityFlags = (
  ...flags: ReadonlyArray<ReadonlyArray<string> | undefined>
): string[] => [...new Set(flags.flatMap((values) => values ?? []))];

/** @internal Lower framework DOs while preserving application ownership. */
export const reconcileViteFrameworkDurableObjects = Effect.fn(function* ({
  applicationBindings,
  durableObjects,
  workerName,
}: {
  applicationBindings: ReadonlyArray<WireWorkerBinding>;
  durableObjects: ViteFrameworkBuildOutput["durableObjects"];
  workerName: string;
}) {
  const bindings: WireWorkerBinding[] = [];
  const frameworkOwned: Array<{ binding: string; className: string }> = [];
  const hostedClasses = new Set(
    applicationBindings.flatMap((binding) =>
      binding.type === "durable_object_namespace" &&
      binding.className !== undefined &&
      (binding.scriptName === undefined || binding.scriptName === workerName)
        ? [binding.className]
        : [],
    ),
  );

  for (const durableObject of durableObjects) {
    const existing = applicationBindings.filter(
      (binding) => binding.name === durableObject.binding,
    );
    if (existing.length === 0) {
      bindings.push({
        type: "durable_object_namespace",
        name: durableObject.binding,
        className: durableObject.className,
      });
      if (!hostedClasses.has(durableObject.className)) {
        hostedClasses.add(durableObject.className);
        frameworkOwned.push(durableObject);
      }
      continue;
    }

    const applicationOwnsExactDeclaration = existing.every(
      (binding) =>
        binding.type === "durable_object_namespace" &&
        binding.className === durableObject.className &&
        (binding.scriptName === undefined || binding.scriptName === workerName),
    );
    if (applicationOwnsExactDeclaration) continue;

    return yield* Effect.fail(
      new ViteFrameworkContributionError({
        bindingName: durableObject.binding,
        reason: `the framework hosts class '${durableObject.className}', but the application declares ${existing
          .map((binding) =>
            binding.type === "durable_object_namespace"
              ? `Durable Object class '${binding.className ?? "<missing>"}'${
                  binding.scriptName === undefined
                    ? " on this Worker"
                    : ` on Worker '${binding.scriptName}'`
                }`
              : `a '${binding.type}' binding`,
          )
          .join(", ")}`,
      }),
    );
  }

  return { bindings, durableObjects: frameworkOwned };
});

/** @internal Resolve the stable logical identities used by DO migrations. */
export function getDurableObjectBindings(
  bindings: ReadonlyArray<ResourceBinding<Worker["Binding"]>>,
  workerName: string,
  frameworkDurableObjects: ViteFrameworkBuildOutput["durableObjects"] = [],
) {
  const seen = new Set<string>();
  const resourceBindings = bindings.flatMap((binding) =>
    (binding.data.bindings ?? []).flatMap((item: WorkerBinding) => {
      if (
        item.type !== "durable_object_namespace" ||
        !("className" in item) ||
        !item.className ||
        (item.scriptName !== undefined && item.scriptName !== workerName)
      ) {
        return [];
      }
      const dedupKey = `${binding.sid}::${item.name}::${item.className}`;
      if (seen.has(dedupKey)) return [];
      seen.add(dedupKey);
      return [
        {
          logicalId: binding.sid,
          bindingName: item.name,
          className: item.className,
          transferredFrom:
            Array.isArray(item.transferredFrom) &&
            item.transferredFrom.length === 0
              ? undefined
              : item.transferredFrom,
        },
      ];
    }),
  );
  return [
    ...resourceBindings,
    ...frameworkDurableObjects.map((binding) => ({
      logicalId: `vite:${binding.binding}`,
      bindingName: binding.binding,
      className: binding.className,
      transferredFrom: undefined,
    })),
  ];
}
