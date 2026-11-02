import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";

/**
 * A single-node Key Value Store. A Function has no fixed egress address, so this instance
 * takes connections from everywhere, behind its generated password. Narrow `acl` when
 * your hosts have known addresses.
 */
export const Cache = Stackit.Valkey.Instance("Cache", {
  version: "x",
  planName: "stackit-keyvalue-1.2.10-single",
  acl: ["0.0.0.0/0"],
});

/** The user and password the function connects with. */
export const App = Cache.pipe(
  Effect.flatMap((cache) => Stackit.Valkey.Credential("App", { instanceId: cache.instanceId })),
);
