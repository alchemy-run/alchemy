// An async Web Function in the Cloudflare Worker / Hono shape: a default
// export with a Web-standard `fetch`.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/stream") {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const [i, chunk] of ["one\n", "two\n", "three\n"].entries()) {
            if (i > 0) await sleep(600);
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/echo" && request.method === "POST") {
      return Response.json({ method: request.method, body: await request.text() });
    }

    return new Response(`greeting=${process.env.GREETING ?? "missing"}`, {
      headers: { "set-cookie": "a=1", "x-fixture": "async-fetch" },
    });
  },
};
