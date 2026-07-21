import { proxyChain } from "@/Util/proxy-chain.ts";
import * as Effect from "effect/Effect";

/**
 * Compile-time regression tests for `proxyChain`'s channel preservation:
 * the cached effect's error and requirement channels must survive onto
 * every Effect yielded through the chain (they used to be erased), while
 * a channel-free cached effect keeps the exact original type.
 */

class ConnectError {
  readonly _tag = "ConnectError";
}
class QueryError {
  readonly _tag = "QueryError";
}
interface Session {
  readonly _: unique symbol;
}
interface Reactivity {
  readonly _: unique symbol;
}

interface Db {
  select(): {
    from(table: string): Effect.Effect<string[], QueryError, Reactivity>;
  };
}

declare const withChannels: Effect.Effect<Db, ConnectError, Session>;
export const handle = proxyChain(withChannels);
export const query = handle.select().from("users");

type ErrorOf<T> =
  T extends Effect.Effect<unknown, infer X, unknown> ? X : never;
type RequirementsOf<T> =
  T extends Effect.Effect<unknown, unknown, infer X> ? X : never;
type Assert<T extends true> = T;

type _CachedErrorSurvives = Assert<
  ConnectError extends ErrorOf<typeof query> ? true : false
>;
type _LeafErrorKept = Assert<
  QueryError extends ErrorOf<typeof query> ? true : false
>;
type _CachedRequirementSurvives = Assert<
  Session extends RequirementsOf<typeof query> ? true : false
>;
type _LeafRequirementKept = Assert<
  Reactivity extends RequirementsOf<typeof query> ? true : false
>;

// A channel-free cached effect is the identity: the handle is exactly `T`,
// preserving generic method signatures (the drizzle fast path).
declare const channelFree: Effect.Effect<Db>;
export const plainHandle = proxyChain(channelFree);
type _IdentityWhenChannelFree = Assert<
  typeof plainHandle extends Db
    ? Db extends typeof plainHandle
      ? true
      : false
    : false
>;
