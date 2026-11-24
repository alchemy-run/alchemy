import { expect, it } from "vitest";
import forwarder from "../../bindings/dispatch-namespace/DispatchShimForward.worker.ts";

// The forwarder retries one measured answer: the shim's workers.dev URL before
// it serves, which answers without the shim's mark. A fetch that throws was
// never measured as transient, so it fails the dispatch at once, as the queue
// forwarder lets it.
it("a fetch to the shim that throws fails the dispatch at once, unretried", async () => {
  const started = Date.now();
  await expect(
    forwarder.fetch!(
      new Request("http://dispatch/probe"),
      {
        // Nothing listens on port 1: the connection is refused.
        SHIM_URL: "http://127.0.0.1:1",
        SHIM_TOKEN: "token",
      } as never,
      {} as never,
    ),
  ).rejects.toThrow();
  // The first retry would wait 1 s.
  expect(Date.now() - started).toBeLessThan(1_000);
}, 5_000);
