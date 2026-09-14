interface Env {
  QUEUE: Queue<string>;
  DB: D1Database;
}

async function receipts(env: Env) {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  );
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const text = url.searchParams.get("text") ?? "hello";
      await env.QUEUE.send(text);
      return Response.json({ sent: text });
    }
    await receipts(env);
    const rows = await env.DB.prepare(
      "SELECT body FROM receipts ORDER BY id",
    ).all<{ body: string }>();
    return Response.json({ received: rows.results.map((row) => row.body) });
  },
  async queue(batch: MessageBatch<string>, env: Env) {
    await receipts(env);
    await env.DB.batch(
      batch.messages.map((message) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO receipts (id, body) VALUES (?, ?)",
        ).bind(message.id, message.body),
      ),
    );
  },
};
