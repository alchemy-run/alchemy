// Minimal queue-consumer function: the queue trigger in .vc-config.json is
// what matters (it configures the project's consumer registry so the data
// plane accepts sends). Queue deliveries arrive as POSTs; note that a
// function carrying a queue trigger loses ALL public HTTP routing
// (live-verified), so this handler is effectively private.
export default {
  async fetch(request) {
    if (request.method === "POST") {
      await request.text();
      return Response.json({ received: true });
    }
    return Response.json({ ok: true });
  },
};
