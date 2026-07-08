/**
 * Plain (non-Effect) worker fixture for the test-logging pipeline. External
 * workers get the console patch through the generated wrapper entry
 * (`makeExternalWrappedEntry`), so this module stays a vanilla
 * `ExportedHandler` — exactly what an Alchemy end user would write.
 *
 * GET /?marker=<m> → console.log + console.error tagged with <m>, returns
 * `{ requestId }` echoing the `alchemy-request-id` header.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url, "http://x");
    const marker = url.searchParams.get("marker") ?? "none";
    console.log(`async-log ${marker}`);
    console.error(`async-error ${marker}`);
    return Response.json({
      requestId: request.headers.get("alchemy-request-id"),
    });
  },
};
