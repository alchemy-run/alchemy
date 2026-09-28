import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * A provider group that holds the sidecar's event loop for 4 seconds when
 * SIGTERM arrives, like synchronous work that is still running when
 * `alchemy dev` stops. The sidecar's own SIGTERM handling starts after it.
 */
process.prependListener("SIGTERM", () => {
  const end = Date.now() + 4_000;
  while (Date.now() < end) {}
});

class Busy extends Context.Service<Busy, {}>()("Test.Busy") {}

export default Layer.succeed(Busy, {});
