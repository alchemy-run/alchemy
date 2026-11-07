import * as Move from "alchemy/Workers/Workerd/DurableObjectMove";
import * as Effect from "effect/Effect";
import { type DurableObjectJurisdiction } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { LOCAL, dynamic, forwardTo, sharedStub } from "./Forwarding.ts";
import { type Classes, ID_KEY, MOVED, type ObjectImpl, SEALED } from "./ModelClass.ts";

/**
 * An old class's objects while they move to the model's class: they serve with
 * the same code, log their writes for the move once it begins, and answer the
 * move's calls. Once sealed, a call goes to the new object of the same key.
 */

/**
 * A version 0 class while its objects move: it serves with the same code as
 * the new one, and logs its writes for the move once one begins. Once sealed,
 * every call goes to the new object of the same key.
 */
export const legacyObject = (classes: Classes, route: string, impl: ObjectImpl): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const raw = state.raw?.storage;
    // At deploy time the class is declared with a placeholder state.
    if (raw?.kv === undefined) return yield* impl;
    // Count its work from now on, and keep logging a move already under way.
    Move.watchSource(raw);
    const inner = yield* impl;
    return Effect.gen(function* () {
      const instance = (yield* inner) as Record<string, unknown>;
      const key = Effect.gen(function* () {
        // An object created before Durable Objects kept their names: the key it stored.
        return state.id.name ?? (yield* Effect.promise(() => raw.get<string>(ID_KEY))) ?? undefined;
      });
      const target = Effect.map(key, (name) =>
        name === undefined
          ? undefined
          : sharedStub(
              classes,
              route,
              name,
              state.id.jurisdiction as DurableObjectJurisdiction | undefined,
            ),
      );
      const moves: Record<string, unknown> = {
        // A sealed object that doesn't know its key has moved, and emptied its storage (the
        // key with it): it answers as moved, so the migration doesn't count it as stuck.
        domainName: () =>
          Effect.flatMap(key, (name) =>
            name === undefined && Move.isSealing(raw)
              ? Effect.die(new Error(`This Durable Object's ${MOVED}`))
              : Effect.succeed(name ?? null),
          ),
        domainMoveBegin: () => Move.beginSource(raw),
        domainMoveSnapshot: (after: Move.SnapshotCursor) => Move.snapshotPage(raw, after),
        domainMoveChanges: (after: number) => Move.changesPage(raw, after),
        domainMoveSeal: () => Move.seal(raw, () => state.raw.getWebSockets()),
        domainMoveSql: (at: Move.SqlCursor | null) => Move.sqlPage(raw, at),
        domainMoveFinish: () => Move.finish(raw),
        /** A call the new object forwards while it doesn't own the key: refused once sealed. */
        domainForward: (prop: string, args: ReadonlyArray<unknown>) => {
          if (Move.isSealing(raw)) return Effect.die(new Error(SEALED));
          const member = instance[prop];
          if (typeof member !== "function")
            return Effect.die(new Error(`${prop} is not a method of ${route}`));
          return Move.counted(
            raw,
            (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
          );
        },
      };
      return dynamic((prop) => {
        if (prop in moves) return moves[prop];
        if (Move.isSealing(raw)) {
          // Moved: the new object answers. Its stored callbacks moved with it.
          if (prop === Move.OwnsAlarmCallbacks) return true;
          if (prop === "alarm") return () => Effect.void;
          return LOCAL.has(prop) ? undefined : forwardTo(target, prop);
        }
        const member = instance[prop];
        // A call under way: a seal waits for it.
        if (typeof member === "function")
          return (...args: ReadonlyArray<unknown>) =>
            Move.counted(
              raw,
              (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
            );
        if (Effect.isEffect(member)) return Move.counted(raw, member);
        return member;
      });
    });
  });
