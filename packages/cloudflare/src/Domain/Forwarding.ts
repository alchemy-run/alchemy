import * as Move from "alchemy/Workers/Workerd/DurableObjectMove";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { type DurableObjectJurisdiction } from "../Workers/DurableObject.ts";
import { makeRpcStub } from "../Workers/Rpc.ts";
import { type Classes, DomainMoveFailed, type Stub, failed } from "./ModelClass.ts";

/**
 * Reaching another object while a key moves: an instance whose members are
 * looked up per call, forwarding a member to another stub, the old and new
 * objects of a key, and the old object's calls the move makes.
 */

/** How a forwarded call came back: answered, refused by a sealed object, or on older code. */
export type Forwarded =
  | { readonly value: unknown }
  | { readonly sealed: true }
  | { readonly stale: true };

/** The old object of `key`, while the Worker still has its class. */
export const legacyStub = (
  classes: Classes,
  route: string,
  key: string,
  jurisdiction: string | undefined,
): Stub | undefined => {
  const legacy = classes.movers.get(route);
  const namespace = legacy === undefined ? undefined : classes.env?.[legacy];
  if (namespace === undefined || typeof namespace.getByName !== "function") return undefined;
  const scoped = jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
  return makeRpcStub<Stub>(scoped.getByName(key));
};

/** The new object of `key` in the shared class. */
export const sharedStub = (
  classes: Classes,
  route: string,
  key: string,
  jurisdiction: DurableObjectJurisdiction | undefined,
): Stub => {
  const namespace =
    jurisdiction === undefined ? classes.namespace : classes.namespace.jurisdiction(jurisdiction);
  return namespace.getByName(`${route}/${key}`) as Stub;
};

/** The old object, as the new one calls it during a move. */
export const sourceCalls = (from: Stub): Move.SourceCalls => {
  const call = <A>(what: string, effect: Effect.Effect<unknown, unknown>) =>
    effect.pipe(Effect.mapError(failed(what))) as Effect.Effect<A, DomainMoveFailed>;
  return {
    begin: () => call("starting the move", from.domainMoveBegin!()),
    snapshot: (after) => call("copying", from.domainMoveSnapshot!(after)),
    changes: (after) => call("catching up", from.domainMoveChanges!(after)),
    seal: () => call("sealing the old object", from.domainMoveSeal!()),
    sql: (at) => call("copying its tables", from.domainMoveSql!(at)),
    finish: () => call("emptying the old object", from.domainMoveFinish!()),
  };
};

/** Members the runtime looks up on an instance that are not calls to forward. */
const UNFORWARDED = new Set(["then", "toJSON", "constructor", "pipe"]);

/**
 * An instance whose members are looked up when they are used: `members()`
 * decides, so one object can change what it does (forward, or serve) while it
 * lives. The bridge checks members with `Object.hasOwn`, which this answers.
 */
export const dynamic = (members: (prop: string) => unknown): Record<string, unknown> =>
  new Proxy({} as Record<string, unknown>, {
    get: (_, prop) =>
      typeof prop !== "string" || UNFORWARDED.has(prop) ? undefined : members(prop),
    getOwnPropertyDescriptor: (_, prop) => {
      if (typeof prop !== "string" || UNFORWARDED.has(prop)) return undefined;
      const value = members(prop);
      return value === undefined
        ? undefined
        : { value, configurable: true, enumerable: false, writable: false };
    },
  });

/** Forward a member to another object's stub: a method call, or `fetch`. */
export const forwardTo = (stub: Effect.Effect<Stub | undefined>, prop: string): unknown =>
  prop === "fetch"
    ? Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const target = yield* stub;
        if (target === undefined)
          return HttpServerResponse.text("This object moved and has no name", { status: 410 });
        return yield* (
          target as unknown as {
            fetch: (
              request: HttpServerRequest,
            ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
          }
        )
          .fetch(request)
          .pipe(Effect.orDie);
      })
    : (...args: ReadonlyArray<unknown>) =>
        Effect.flatMap(stub, (target) =>
          target === undefined
            ? Effect.die(new Error(`an object without a name can't forward ${prop}`))
            : target[prop]!(...args),
        );

/** WebSocket and alarm members that a forwarding object handles itself. */
export const LOCAL = new Set(["webSocketMessage", "webSocketClose", "webSocketError"]);
