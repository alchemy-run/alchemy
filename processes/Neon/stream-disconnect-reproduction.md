# Neon Function HTTP disconnect propagation

Observed on the deployed `nodejs24` runtime in `aws-us-east-2`, 2026-09-20. This is an upstream transport defect, separate from Alchemy's handling of a supplied abort signal. Reported upstream as [neondatabase/neon-pkgs#636](https://github.com/neondatabase/neon-pkgs/issues/636).

## Minimal native handler

This handler does not import Alchemy or Effect:

```ts
export default {
  fetch(request: Request) {
    request.signal.addEventListener("abort", () => console.info("request aborted"), { once: true });
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 100));
        controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
      },
      cancel() {
        console.info("response cancelled");
      },
    }), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
    });
  },
};
```

Deploy it as a fresh Function, then terminate a client after receiving data:

```sh
curl --no-buffer --http1.1 --noproxy '*' --max-time 2 "$FUNCTION_URL"
```

Expected: the host cancels the response producer and exposes premature disconnect through the request signal. Neon's [SSE example](https://neon.com/docs/compute/functions/websockets#server-sent-events-sse) explicitly documents `cancel()` on client disconnect.

## Verified observations

The stronger deployed diagnostic awaited a Postgres record before enqueueing each chunk, with separate records for request abort and response cancellation. This avoids relying only on absent logs or losing asynchronous telemetry.

| Control | Observed result |
| --- | --- |
| Connected pull producer | Six recorded and delivered chunks, then normal completion |
| Connected push producer | Six recorded and delivered chunks, then normal completion |
| Pull producer after killed curl | Five total chunks; no additional chunks, abort, or cancel during the subsequent five-second observation |
| Push producer after killed curl | Advanced from three to 26 chunks over five seconds; no abort or cancel |

The run completed in 25 seconds, used at most 808 MiB locally, destroyed its owned project normally, and independently observed project `NotFound`. Earlier native/Effect plain/SSE tests also observed no disconnect finalization within two minutes; that does not establish that cancellation can never arrive.

## Identified host defect

Authenticated inspection of a disposable Function's Node language worker identified `/runtime/runtime.js`, `pumpReaderIdentity`, lines 537–551 in the inspected deployment. Its uncompressed response loop awaits `reader.read()`, writes the chunk, and on `res.write()` returning false waits exclusively for the next `drain` event. The containing `streamIdentity` function catches failures by destroying the response, but does not cancel or release the reader.

A prematurely closed response can return false from `write()` without ever emitting another `drain`. The pump then remains pending and retains the producer without invoking its `cancel()` callback. A source already awaiting its next value also needs cancellation independent of subsequent data production.

Running the extracted pump over a real local Node 24 HTTP connection reproduced:

| Pump | Connection closed | Producer cancelled | Pump settled |
| --- | --- | --- | --- |
| Deployed identity pump | Yes | No | No |
| `pipeline(Readable.fromWeb(body), res)` comparison | Yes | Yes | Yes |

The standard Node pipeline comparison is a verified correction to the isolated identity-pump defect, not a deployed platform fix. Upstream needs to cover the same ownership requirements throughout the response path:

- Cancel the source and settle pending reads/writes on premature close or error.
- Preserve ordinary backpressure without interpreting it as disconnection.
- Release reader locks and close/error listeners after completion.
- Handle disconnect during compression peeking as well as identity/compressed pumping.
- Connect transport disconnect to the incoming Web Request's abort signal and verify forwarding proxies propagate disconnects.

The deployed host is not part of Alchemy or the public `@neon/functions` helper package. The referenced `neondatabase/neon-cloud` repository was inaccessible from this account. No deployed-host modification or full-platform fix is claimed.

## Alchemy correction

Alchemy's response producer runs independently of the effect that initially returns the Fetch response. Closing only the request scope on abort did not reliably interrupt that producer; the old local regression masked this by explicitly cancelling its reader afterward.

The bridge now pipes the Web response body through a standard `TransformStream` with the actual request `AbortSignal`. Body cancellation or a real request abort therefore reaches the source, including while a source read is pending or the consumer is backpressured. Stream exit closes the transferred request scope. Native WebSocket upgrade responses retain their object identity and existing socket-close lifecycle.

The idle watchdog has been removed. The tests assert stream and request finalizers before explicit cleanup, and the deployed regression continues to require native cancellation rather than pinning the broken behavior as success. The bridge cannot synthesize an abort when the host supplies neither cancellation signal.
