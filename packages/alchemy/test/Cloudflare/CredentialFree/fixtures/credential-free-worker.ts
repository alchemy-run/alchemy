// Async (non-Effect) Worker exercising every major local binding in one
// script — KV, R2, D1, Queues (producer + consumer), and a Secrets Store
// secret — so the credential-free suite can prove the whole local data
// plane works without any configured Cloudflare credentials.
interface Env {
  KV: {
    put(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
  };
  BUCKET: {
    put(key: string, value: string): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
  DB: {
    exec(sql: string): Promise<{ count: number }>;
    prepare(sql: string): {
      bind(...params: unknown[]): {
        run(): Promise<{ success: boolean }>;
        all<T>(): Promise<{ results: T[] }>;
      };
      run(): Promise<{ success: boolean }>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
  QUEUE: {
    send(body: unknown, options?: { contentType?: string }): Promise<void>;
  };
  SECRET: { get(): Promise<string> };
}

const received: string[] = [];

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/kv") {
      await env.KV.put("greeting", "hello-kv");
      const value = await env.KV.get("greeting");
      return Response.json({ value });
    }
    if (url.pathname === "/r2") {
      await env.BUCKET.put("greeting.txt", "hello-r2");
      const object = await env.BUCKET.get("greeting.txt");
      return Response.json({
        text: object === null ? null : await object.text(),
      });
    }
    if (url.pathname === "/d1") {
      await env.DB.exec(
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      );
      await env.DB.prepare("DELETE FROM users").run();
      await env.DB.prepare("INSERT INTO users (name) VALUES (?)")
        .bind("alice")
        .run();
      const all = await env.DB.prepare(
        "SELECT name FROM users ORDER BY name",
      ).all<{ name: string }>();
      return Response.json({ names: all.results.map((r) => r.name) });
    }
    if (url.pathname === "/queue/send") {
      const text = url.searchParams.get("text") ?? "hello-queue";
      await env.QUEUE.send(text, { contentType: "text" });
      return Response.json({ sent: text });
    }
    if (url.pathname === "/queue/received") {
      return Response.json({ received });
    }
    if (url.pathname === "/secret") {
      try {
        const value = await env.SECRET.get();
        return Response.json({ value });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 404 });
      }
    }
    return new Response("not found", { status: 404 });
  },
  queue: async (batch: { messages: Array<{ body: unknown }> }) => {
    for (const message of batch.messages) {
      received.push(String(message.body));
    }
  },
};
