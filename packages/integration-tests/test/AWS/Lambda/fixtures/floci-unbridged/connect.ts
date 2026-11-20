import * as ElastiCache from "@alchemy.run/aws/ElastiCache";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * A Function emulated by `alchemy dev` connecting to a cache in the real
 * cloud, which only has a private endpoint in its VPC.
 */
export class UnbridgedConnectFunction extends Lambda.Function<UnbridgedConnectFunction>()(
  "UnbridgedConnectFunction",
) {}

export default UnbridgedConnectFunction.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const cache = yield* ElastiCache.ServerlessCache("UnbridgedCache", {}).pipe(Alchemy.remote());
    yield* ElastiCache.Connect(cache);
  }).pipe(Effect.provide(ElastiCache.ConnectHttp)),
);
