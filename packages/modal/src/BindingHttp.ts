import type { Input } from "alchemy/Input";
import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { OperationServices } from "./internal.ts";
import * as ModalBindings from "./ModalBindings.ts";

/**
 * Shared scaffolding for Modal's HTTP bindings. NOT exported from `index.ts`.
 *
 * Every `{Cap}Http.ts` is a thin `Layer.effect(Cap, makeModalBinding({ … }))`:
 * the operations it calls (resolved once with the host's credentials by
 * {@link ModalBindings.withCredentials}), the environment role it grants the
 * host's identity on the bound resource's environment, and the client it
 * builds. `make` runs in the construction phase, so it reads the resource's
 * attribute accessors there (`yield* volume.volumeId`) and yields them per call.
 */

/** A role on an environment, granted to the host's identity. */
export type Role = ModalBindings.EnvironmentGrant["role"];

const GrantRole = Effect.gen(function* () {
  const bind = yield* ModalBindings.Bind;
  return Effect.fn(function* (
    label: TemplateStringsArray,
    args: ReadonlyArray<unknown>,
    environment: Input<string | undefined>,
    role: Role,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind(label, ...args)({ roles: [{ environment, role }] });
    }
  });
});

/** A binding over one resource that lives in an environment. */
export const makeModalBinding = <
  Res extends ResourceLike & { readonly environment: unknown },
  Ops,
  Client,
>(options: {
  /** Fully qualified binding tag, e.g. `Modal.WriteQueue`. */
  readonly tag: string;
  /** The distilled operations the client calls, e.g. `operations({ put: queue.putQueue })`. */
  readonly operations: Effect.Effect<Ops, never, OperationServices>;
  /** The role the host needs on the resource's environment. */
  readonly role: Role;
  readonly make: (resource: Res, ops: Ops) => Effect.Effect<Client>;
}) =>
  Effect.gen(function* () {
    const ops = yield* ModalBindings.withCredentials(options.operations);
    const grant = yield* GrantRole;
    return Effect.fn(options.tag)(function* (resource: Res) {
      yield* grant(
        labelOf(options.tag),
        [resource],
        resource.environment as Input<string | undefined>,
        options.role,
      );
      return yield* options.make(resource, ops);
    });
  });

/**
 * A binding with no bound resource (get-or-create by name at runtime): the
 * role is granted on the environment `environmentOf(args)` names, the
 * workspace default when `undefined`.
 */
export const makeOpenModalBinding = <Args extends ReadonlyArray<unknown>, Ops, Client>(options: {
  readonly tag: string;
  readonly operations: Effect.Effect<Ops, never, OperationServices>;
  readonly role: Role;
  /** The environment the client acts in (an `Input`, read at deploy). */
  readonly environmentOf: (...args: Args) => Input<string | undefined>;
  readonly make: (ops: Ops, ...args: Args) => Effect.Effect<Client>;
}) =>
  Effect.gen(function* () {
    const ops = yield* ModalBindings.withCredentials(options.operations);
    const grant = yield* GrantRole;
    return Effect.fn(options.tag)(function* (...args: Args) {
      yield* grant(openLabelOf(options.tag), [], options.environmentOf(...args), options.role);
      return yield* options.make(ops, ...args);
    });
  });

/** `<tag>(<resource>)` as a template label. */
const labelOf = (tag: string): TemplateStringsArray =>
  Object.assign([`${tag}(`, ")"], { raw: [`${tag}(`, ")"] }) as unknown as TemplateStringsArray;

/** `<tag>` as a template label. */
const openLabelOf = (tag: string): TemplateStringsArray =>
  Object.assign([tag], { raw: [tag] }) as unknown as TemplateStringsArray;

/** A stored value isn't JSON (e.g. a pickled value written by Modal's Python client). */
export class ModalValueNotJson extends Data.TaggedError("Modal.ValueNotJson")<{
  readonly message: string;
}> {}

/** JSON-encode a value as base64 bytes, Modal's `bytes` wire form. */
export const encodeJson = (value: unknown) =>
  Effect.sync(() => Buffer.from(JSON.stringify(value), "utf8").toString("base64"));

/** Decode base64 JSON bytes written by {@link encodeJson} or any JSON writer. */
export const decodeJson = <A = unknown>(data: string) =>
  Effect.try({
    try: () => JSON.parse(Buffer.from(data, "base64").toString("utf8")) as A,
    catch: () =>
      new ModalValueNotJson({
        message:
          "The stored value isn't JSON. Values written by Modal's Python client are pickled; write them as JSON (bytes of json.dumps) to share them.",
      }),
  });
