import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Who created an object at run time: the stack, stage and binding host
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`).
 *
 * The `Create*` bindings mark every object they create with it, so the
 * objects can be found and cleaned up. Destroying the stack does not delete
 * them. Modal tags sandboxes, so a sandbox carries the three keys as tags;
 * volumes, dicts, queues and secrets have only a name, so theirs starts with
 * {@link runtimePrefix}, and `alchemy nuke` deletes them by it.
 */
export interface RuntimeOwner {
  readonly stack: string;
  readonly stage: string;
  readonly id: string;
}

/** The owner as Modal sandbox tags. */
export const runtimeTags = (owner: RuntimeOwner): Record<string, string> => ({
  "alchemy::stack": owner.stack,
  "alchemy::stage": owner.stage,
  "alchemy::id": owner.id,
});

const toLabel = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** FNV-1a, 32 bits: a short, stable digest of the full identity. */
const digest = (value: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * The name prefix of objects that carry only a name:
 * `alc-<stack-stage-id>-<digest>`, the identity readable and cut to 16
 * characters, then a digest of all three. An object `name` becomes
 * `<prefix>-<name>`. The `alc-` marker is how `alchemy nuke` recognizes them.
 */
export const runtimePrefix = (owner: RuntimeOwner): string => {
  const readable =
    toLabel(`${owner.stack}-${owner.stage}-${owner.id}`).slice(0, 16).replace(/-+$/, "") || "x";
  return `alc-${readable}-${digest(`${owner.stack}/${owner.stage}/${owner.id}`)}`;
};

/** Whether `name` carries some owner's {@link runtimePrefix}. */
export const isRuntimeName = (name: string | undefined): boolean =>
  name !== undefined && /^alc-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9a-f]{8}-./.test(name);

/** The name an object gets: `<prefix>-<name>` with an owner, `name` without one. */
export const ownedName = (owner: RuntimeOwner | undefined, name: string) =>
  owner === undefined ? name : `${runtimePrefix(owner)}-${name}`;

/** An owned object's name without the prefix, or `undefined` when another owner's. */
export const unownedName = (owner: RuntimeOwner | undefined, name: string) => {
  if (owner === undefined) return name;
  const prefix = `${runtimePrefix(owner)}-`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
};

const ENV = {
  stack: "ALCHEMY_MODAL_OWNER_STACK",
  stage: "ALCHEMY_MODAL_OWNER_STAGE",
  id: "ALCHEMY_MODAL_OWNER_ID",
} as const;

/**
 * The owner a `Create*` binding marks its objects with. Yield it while the
 * binding's layer is built and call the result inside the binding: at deploy
 * it binds the host's identity into the host's env; at run time its Effect
 * reads it back. Without a host (a script or an Action) there is no owner.
 */
export const RuntimeOwnerOf = Effect.fn(function* () {
  const runtime = yield* CurrentRuntimeContext;
  if (runtime === undefined) return Effect.succeed<RuntimeOwner | undefined>(undefined);
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    // The deploying stack and stage, read without requiring them, so the
    // binding's `make` needs nothing a script or an Action lacks.
    const stack = Option.getOrUndefined(yield* Effect.serviceOption(Stack));
    const stage = Option.getOrUndefined(yield* Effect.serviceOption(Stage));
    if (host !== undefined && stack !== undefined && stage !== undefined) {
      yield* runtime.set(ENV.stack, Output.literal(stack.name));
      yield* runtime.set(ENV.stage, Output.literal(stage));
      yield* runtime.set(ENV.id, Output.literal(host.LogicalId));
    }
  }
  return Effect.gen(function* () {
    const stack = yield* runtime.get<string>(ENV.stack);
    const stage = yield* runtime.get<string>(ENV.stage);
    const id = yield* runtime.get<string>(ENV.id);
    return stack === undefined || stage === undefined || id === undefined
      ? undefined
      : ({ stack, stage, id } satisfies RuntimeOwner);
  });
});
