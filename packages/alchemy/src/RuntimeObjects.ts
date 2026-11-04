import * as Effect from "effect/Effect";
import { createPhysicalName } from "./PhysicalName.ts";
import { createInternalTags } from "./Tags.ts";

/**
 * Objects a program creates at run time (a sandbox per request, a volume
 * per user, a secret per tenant) are not in Alchemy state. A runtime
 * binding (`CreateSandbox()`, `CreateVolume()`, …) declares a provider's
 * `RuntimeObjects` resource instead: it carries the ownership stamp the
 * binding writes on everything it creates, and destroying it sweeps them.
 *
 * Every provider stamps with what its platform has: {@link RuntimeObjectsAttributes.tags}
 * for labels or metadata, {@link RuntimeObjectsAttributes.owner} for a
 * description marker, or {@link RuntimeObjectsAttributes.prefix} for a name
 * prefix when objects carry nothing else.
 *
 * ```ts
 * // packages/<provider>/src/RuntimeObjects.ts
 * export const RuntimeObjects = Resource<RuntimeObjects>("Daytona.RuntimeObjects");
 * export const RuntimeObjectsProvider = () =>
 *   Provider.effect(
 *     RuntimeObjects,
 *     Effect.succeed(RuntimeObjects.lifecycle((attrs) => sweepDaytona(attrs))),
 *   );
 * ```
 */

/** What destroying a runtime binding does with the objects it created. */
export type OnDestroy = "delete" | "retain";

export interface RuntimeObjectsProps<Kind extends string = string> {
  /** The kinds of object the binding creates. */
  kinds: ReadonlyArray<Kind>;
  /**
   * `"delete"` removes every object the binding created when it is
   * destroyed; `"retain"` leaves them (user data in production, say).
   * @default "delete"
   */
  onDestroy?: OnDestroy;
}

export interface RuntimeObjectsAttributes<Kind extends string = string> {
  /** `alchemy::stack`, `alchemy::stage` and `alchemy::id`, for labels or metadata. */
  tags: Record<string, string>;
  /** The same identity as one string (`stack/stage/id`), for a description marker. */
  owner: string;
  /**
   * A stable DNS-label prefix (lowercase letters, digits, `-`), for objects
   * that carry nothing but a name: `<prefix>-<name>`.
   */
  prefix: string;
  kinds: ReadonlyArray<Kind>;
  onDestroy: OnDestroy;
}

/** The name a runtime object gets under a prefix. */
export const runtimeName = (prefix: string, name: string) => `${prefix}-${name}`;

/** Whether a name carries a prefix. */
export const isRuntimeName = (prefix: string, name: string | undefined) =>
  name?.startsWith(`${prefix}-`) ?? false;

const toDnsLabel = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** The stamp for a binding: kept from `output` once issued, so it never drifts. */
export const stamp = Effect.fn(function* <Kind extends string>(
  id: string,
  news: RuntimeObjectsProps<Kind>,
  output: RuntimeObjectsAttributes<Kind> | undefined,
) {
  const tags = output?.tags ?? (yield* createInternalTags(id));
  const prefix =
    output?.prefix ??
    toDnsLabel(
      yield* createPhysicalName({
        id,
        maxLength: 30,
        suffixLength: 8,
        delimiter: "-",
        lowercase: true,
      }),
    );
  return {
    tags,
    owner: output?.owner ?? Object.values(tags).join("/"),
    prefix,
    kinds: news.kinds,
    onDestroy: news.onDestroy ?? "delete",
  } satisfies RuntimeObjectsAttributes<Kind>;
});

/**
 * The lifecycle of a provider's `RuntimeObjects` resource: issue the stamp
 * once, and on delete run `sweep` unless `onDestroy` is `"retain"`. `sweep`
 * deletes every object of `attrs.kinds` that carries the stamp, and must
 * succeed when there is nothing left to delete.
 */
export const lifecycle = <Kind extends string, E, R>(
  sweep: (attrs: RuntimeObjectsAttributes<Kind>) => Effect.Effect<void, E, R>,
) => ({
  // Mutable: `ProviderService.stables` is an array of attribute keys.
  stables: ["tags", "owner", "prefix"] as Array<keyof RuntimeObjectsAttributes<Kind>>,
  nuke: { skip: true },
  list: () => Effect.succeed([]),
  read: Effect.fn(function* ({ output }: { output?: RuntimeObjectsAttributes<Kind> }) {
    return output;
  }),
  reconcile: Effect.fn(function* ({
    id,
    news,
    output,
  }: {
    id: string;
    news: RuntimeObjectsProps<Kind>;
    output?: RuntimeObjectsAttributes<Kind>;
  }) {
    return yield* stamp(id, news, output);
  }),
  delete: Effect.fn(function* ({ output }: { output: RuntimeObjectsAttributes<Kind> }) {
    if (output.onDestroy === "retain") return;
    yield* sweep(output);
  }),
});
