/**
 * Async producer for `WaitUntil.test.ts`: `GET /<label>` logs
 * `lifetime:<label>`, and the trace reaches `WaitUntilWorker`'s `tail`
 * handler, its tail consumer.
 *
 * NOTE: the default export must be this module's only export: workerd
 * rejects any other top-level export.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const label = new URL(request.url).pathname.split("/")[1] ?? "";
    console.log(`lifetime:${label}`);
    return new Response("logged");
  },
};
