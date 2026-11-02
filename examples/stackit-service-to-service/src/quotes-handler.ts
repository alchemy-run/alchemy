const QUOTES = [
  "Simplicity is prerequisite for reliability. — Edsger W. Dijkstra",
  "Make it work, make it right, make it fast. — Kent Beck",
  "Programs must be written for people to read. — Harold Abelson",
];

/**
 * `GET /quote` returns a quote, picked by the optional `?n=` index.
 *
 * A Function has one URL, and nothing here limits who calls it. To keep it to the gateway,
 * check a shared secret from `env` in this handler.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/quote") {
      const n = Number(url.searchParams.get("n") ?? "0");
      const index = Number.isInteger(n) && n >= 0 ? n % QUOTES.length : 0;
      return Response.json({ index, quote: QUOTES[index], servedBy: "quotes" });
    }
    return new Response("not found", { status: 404 });
  },
};
