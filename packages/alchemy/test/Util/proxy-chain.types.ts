import { proxyChain } from "@/Util/proxy-chain.ts";
import * as Effect from "effect/Effect";

/**
 * Compile-time regression tests for `proxyChain`'s soundness contract:
 * the handle is exactly `T` — generic method signatures survive
 * untouched — which is only sound because the cached effect must be
 * channel-free. An error or requirement channel is rejected at the call
 * site instead of silently erased (as it used to be).
 */

class ConnectError {
  readonly _tag = "ConnectError";
}
interface Session {
  readonly _: unique symbol;
}

interface Db {
  // generic method — must survive the handle untouched
  select<A>(fields: A): {
    from(table: string): Effect.Effect<A[], never, never>;
  };
}

declare const channelFree: Effect.Effect<Db>;
export const handle = proxyChain(channelFree);

type Assert<T extends true> = T;

type _HandleIsExactlyT = Assert<
  typeof handle extends Db ? (Db extends typeof handle ? true : false) : false
>;

// generic inference flows through the untouched signature
export const rows = handle.select({ id: 1 }).from("users");
type _GenericInferencePreserved = Assert<
  typeof rows extends Effect.Effect<{ id: number }[], never, never>
    ? true
    : false
>;

declare const failing: Effect.Effect<Db, ConnectError>;
declare const requiring: Effect.Effect<Db, never, Session>;

// @ts-expect-error — an error channel would be erased from the handle
export const rejectsErrorChannel = proxyChain(failing);

// @ts-expect-error — a requirement channel would be erased from the handle
export const rejectsRequirementChannel = proxyChain(requiring);
