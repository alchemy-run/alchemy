/**
 * INTERNAL — calls between instances of one Durable Object class, for
 * Alchemy's own bindings (e.g. `Containers.Harness` asks a designated
 * instance for its build cache). A binding registers a named handler while
 * its Durable Object is constructed; another instance of the class calls it
 * by instance name.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { durableObjectClassName } from "../Containers/Egress.ts";

/** The Durable Object RPC method internal calls are delivered to. */
export const INTERNAL_METHOD = "__alchemyInternal";

type Handler = (payload: unknown) => Effect.Effect<unknown, never, RuntimeContext>;

const handlers = new WeakMap<object, Map<string, Handler>>();

/** Answer internal calls named `name` on this Durable Object instance. */
export const registerInternal = (state: object, name: string, handler: Handler) => {
  let registry = handlers.get(state);
  if (!registry) {
    registry = new Map();
    handlers.set(state, registry);
  }
  registry.set(name, handler);
};

/** @internal Called by the Durable Object bridge. */
export const dispatchInternal = (
  state: object,
  name: string,
  payload: unknown,
): Effect.Effect<unknown, never, RuntimeContext> => {
  const handler = handlers.get(state)?.get(name);
  return handler
    ? handler(payload)
    : Effect.die(new Error(`no internal handler ${name} on this Durable Object`));
};

/** Call `name` on the instance of this Durable Object's class named `instance`. */
export const callInstance = <A>(
  state: cf.DurableObjectState,
  instance: string,
  name: string,
  payload: unknown,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => {
      const className = durableObjectClassName(state);
      const namespace = (state as unknown as { exports?: Record<string, unknown> }).exports?.[
        className ?? ""
      ] as cf.DurableObjectNamespace | undefined;
      if (!namespace) {
        throw new Error(`Durable Object class ${className} is not exported by this Worker`);
      }
      const stub = namespace.get(namespace.idFromName(instance)) as unknown as Record<
        string,
        (name: string, payload: unknown) => Promise<A>
      >;
      return stub[INTERNAL_METHOD]!(name, payload);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
