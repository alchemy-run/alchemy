import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { InheritBinding } from "./InheritBinding.ts";

const TypeId = "Cloudflare.Workers.Inherit" as const;
type TypeId = typeof TypeId;

/**
 * Effect-native accessor for an inherited binding. The env value only exists
 * at the *exec* phase on the deployed Worker, so reading it is deferred behind
 * an Effect that requires {@link RuntimeContext}.
 *
 * Cloudflare copies the previous upload's binding of this name. Alchemy never
 * reads the inherited value. The runtime type is `unknown` because inherit
 * can resolve to a secret, plaintext, or (if you inherit a resource name)
 * whatever that binding was.
 */
export type InheritAccessor = Effect.Effect<unknown, never, RuntimeContext>;

/**
 * Inherit a named binding from this script's latest upload without supplying
 * or reading its value.
 *
 * Cloudflare's upload API accepts only the literal `"latest"` as the inherit
 * source (error 10057). That token is the latest *uploaded* version, not a
 * pin of the 100% deployment. Alchemy always sends `version_id: "latest"`
 * and `bindings_inherit=strict`. Before the upload it refuses unless the
 * latest listed upload is also the sole version currently at 100% traffic.
 * That check is a best-effort preflight, not an atomic lock: a concurrent
 * preview upload can still become `latest` after the check and before the
 * PUT. Treat Alchemy as the exclusive uploader of this script.
 *
 * Do not combine `Inherit` with `version` (preview / gradual rollout) or a
 * dispatch `namespace`. Do not inherit `ALCHEMY_*` or `VITE_*` names.
 * `yield*` requires an explicit name; `env: { NAME: Inherit() }` uses the
 * object key.
 *
 * Not supported in `alchemy dev` — workerd cannot inherit from a Cloudflare
 * version history. Local workerd start fails closed. `dev: { mode: "external" }`
 * does not start workerd and does not materialize inherit.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 *
 * @section Inherit a secret from the latest upload
 * @example Async Worker
 * ```typescript
 * export const Api = Cloudflare.Worker("Api", {
 *   main: "./src/api.ts",
 *   env: {
 *     API_TOKEN: Cloudflare.Workers.Inherit(),
 *   },
 * });
 * ```
 *
 * @example Effect-native Worker
 * ```typescript
 * Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const apiToken = yield* Cloudflare.Workers.Inherit("API_TOKEN");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const token = yield* apiToken;
 *         return new Response(token == null ? "missing" : "ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.InheritBinding)),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/#inherit
 */
export interface Inherit extends Binding.Service<
  Inherit,
  TypeId,
  InheritAccessor
> {
  /**
   * @param name Binding name. Required when `yield*`-ed. When declared as
   *   `env: { API_TOKEN: Inherit() }`, the env key is used.
   */
  (name?: string): InheritBinding;
}

/** Sentinel used only when `Inherit()` is called with no name. */
const UNNAMED = "";

export const Inherit = Binding.Service<Inherit>({
  id: TypeId,
  defaultName: UNNAMED,
  toWorkerBinding: (binding) => ({
    type: "inherit",
    name: binding.name,
    versionId: "latest",
  }),
});

/** Call-site alias for {@link Inherit}. */
export const inherit = Inherit;

const hasInheritKind = (value: object): boolean =>
  "kind" in value && (value as { readonly kind?: unknown }).kind === TypeId;

export const isInherit = (value: unknown): value is InheritBinding => {
  if (typeof value !== "object" || value === null) return false;
  if (Binding.isBinding(value) && value.kind === TypeId) return true;
  if (hasInheritKind(value)) return true;
  if ("~alchemy/Binding" in value) {
    return isInherit(
      (value as { readonly "~alchemy/Binding": unknown })["~alchemy/Binding"],
    );
  }
  return false;
};

/** A Worker's inherit contract is invalid or its source is not the live 100% version. */
export class WorkerInheritConfigError extends Data.TaggedError(
  "WorkerInheritConfigError",
)<{
  message: string;
}> {}

export interface InheritWireBinding {
  readonly type: "inherit";
  readonly name: string;
  readonly versionId?: string;
}

export const isInheritWireBinding = (
  binding: { readonly type?: string } | undefined,
): binding is InheritWireBinding => binding?.type === "inherit";

/**
 * Cloudflare inherit bindings accept only `version_id: "latest"` (error
 * 10057). Without `bindings_inherit=strict`, an unresolvable inherit is
 * silently dropped. Send strict exactly when the upload carries inherit
 * markers.
 */
export const bindingsInheritFor = (
  bindings: readonly { readonly type?: string }[] | undefined,
): "strict" | undefined =>
  bindings?.some(isInheritWireBinding) ? "strict" : undefined;

const fail = (message: string) =>
  Effect.fail(new WorkerInheritConfigError({ message }));

const reservedInheritName = (name: string): string | undefined => {
  if (name.length === 0 || name.trim() !== name) {
    return 'Inherit requires a binding name (env object key, or Inherit("NAME") when yield*-ed).';
  }
  if (name.startsWith("ALCHEMY_")) {
    return `Cannot inherit Alchemy-managed binding '${name}'.`;
  }
  if (name.startsWith("VITE_")) {
    return `Cannot inherit '${name}' — Vite build env would not receive the remote value.`;
  }
  return undefined;
};

/**
 * Reject inherit combined with rollout/preview or a dispatch namespace, and
 * reject reserved inherit names on resource-binding children.
 */
export const assertInheritWorkerProps = (
  news: {
    readonly version?: unknown;
    readonly namespace?: unknown;
  },
  inheritNames: readonly string[],
): Effect.Effect<void, WorkerInheritConfigError> => {
  if (inheritNames.length === 0) return Effect.void;
  if (news.version !== undefined) {
    return fail(
      "Inherit cannot be combined with Worker.version (preview or gradual rollout). Inherit copies the latest upload; a version upload would become that source.",
    );
  }
  if (news.namespace !== undefined) {
    return fail(
      "Inherit is not supported on Workers for Platforms dispatch-namespace uploads.",
    );
  }
  for (const name of inheritNames) {
    const reserved = reservedInheritName(name);
    if (reserved !== undefined) return fail(reserved);
  }
  return Effect.void;
};

export const inheritNamesFromResourceBindings = (
  bindings: readonly {
    readonly data?: {
      readonly bindings?: readonly {
        readonly type?: string;
        readonly name?: string;
      }[];
    };
  }[],
): string[] =>
  bindings.flatMap((binding) =>
    (binding.data?.bindings ?? [])
      .filter(isInheritWireBinding)
      .map((item) => item.name),
  );

export const inheritNamesFromEnv = (
  env: Record<string, unknown> | undefined,
): string[] =>
  env == null
    ? []
    : Object.entries(env)
        .filter(([, value]) => isInheritEnvValue(value))
        .map(([name]) => name);

export const inheritNamesForWorker = (
  news: { readonly env?: Record<string, unknown> },
  bindings: Parameters<typeof inheritNamesFromResourceBindings>[0],
): string[] => [
  ...new Set([
    ...inheritNamesFromResourceBindings(bindings),
    ...inheritNamesFromEnv(news.env),
  ]),
];

export const isInheritEnvValue = (value: unknown): boolean =>
  isInherit(value) ||
  (typeof value === "object" &&
    value !== null &&
    isInheritWireBinding(value as { readonly type?: string }));

/**
 * Resource-binding metadata and `news.env` must agree on inherit vs
 * anything else for the same name. Either direction is rejected so an
 * explicit survivor cannot silently drop an inherit marker, and inherit
 * cannot last-win over another binding. `undefined` is skipped. Stripped
 * `{ kind: "Cloudflare.Workers.Inherit" }` env objects still count as
 * inherit.
 */
export const assertInheritEnvCollision = (
  existing: { readonly type?: string; readonly name?: string },
  envValue: unknown,
): Effect.Effect<void, WorkerInheritConfigError> => {
  if (envValue === undefined) return Effect.void;
  const existingIsInherit = isInheritWireBinding(existing);
  const envIsInherit = isInheritEnvValue(envValue);
  if (existingIsInherit === envIsInherit) return Effect.void;
  return fail(
    `Binding '${existing.name ?? ""}' cannot be both inherited and given an explicit value.`,
  );
};

/**
 * Validate the assembled Worker upload bindings and return the
 * `bindings_inherit` query. Fails on unnamed inherit, reserved names,
 * non-latest inherit tokens, value-bearing inherit markers, and duplicate
 * binding names.
 */
export const finalizeInheritUploadBindings = (
  bindings: readonly {
    readonly type?: string;
    readonly name?: string;
    readonly versionId?: string;
    readonly text?: unknown;
    readonly json?: unknown;
    readonly value?: unknown;
  }[],
): Effect.Effect<"strict" | undefined, WorkerInheritConfigError> =>
  Effect.gen(function* () {
    const names = new Set<string>();
    let inheritCount = 0;
    for (const binding of bindings) {
      const name = binding.name ?? "";
      if (name.length > 0) {
        if (names.has(name)) {
          return yield* fail(
            `Worker binding '${name}' is declared more than once.`,
          );
        }
        names.add(name);
      }
      if (!isInheritWireBinding(binding)) continue;
      inheritCount += 1;
      const reserved = reservedInheritName(name);
      if (reserved !== undefined) return yield* fail(reserved);
      if (binding.versionId !== undefined && binding.versionId !== "latest") {
        return yield* fail(
          `Inherit binding '${name}' must use version_id "latest"; Cloudflare rejects exact version IDs (error 10057).`,
        );
      }
      if (
        binding.text !== undefined ||
        binding.json !== undefined ||
        binding.value !== undefined
      ) {
        return yield* fail(`Inherit binding '${name}' must be value-free.`);
      }
    }
    return inheritCount > 0 ? "strict" : undefined;
  });
