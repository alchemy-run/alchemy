// Vite site worker that writes to a D1 database another Worker also binds
// (the shape from issue #3758). API routes write and count; everything else
// falls through to the assets worker.
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: {
    exec(sql: string): Promise<unknown>;
    prepare(sql: string): {
      bind(...params: unknown[]): { run(): Promise<unknown> };
    };
  };
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/ready") {
      return Response.json({ ready: true });
    }
    if (url.pathname === "/api/concurrent") {
      const who = url.searchParams.get("who") ?? "site";
      const count = Number(url.searchParams.get("count") ?? "100");
      await env.DB.exec(
        "CREATE TABLE IF NOT EXISTS writes (who TEXT NOT NULL, n INTEGER NOT NULL)",
      );
      const errors: string[] = [];
      await Promise.all(
        Array.from({ length: count }, (_, n) =>
          env.DB.prepare("INSERT INTO writes (who, n) VALUES (?, ?)")
            .bind(who, n)
            .run()
            .catch((error: unknown) => {
              errors.push(String(error));
            }),
        ),
      );
      return Response.json({ errors });
    }
    return env.ASSETS.fetch(request);
  },
};
