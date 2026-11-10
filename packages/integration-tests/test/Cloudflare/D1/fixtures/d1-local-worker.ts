// Async (non-Effect) Worker that exercises the native D1 binding against
// the local workerd simulator: exec / prepared statements / batch.
interface Env {
  DB: {
    exec(sql: string): Promise<{ count: number }>;
    prepare(sql: string): {
      bind(...params: unknown[]): {
        run(): Promise<{ success: boolean }>;
        all<T>(): Promise<{ results: T[] }>;
      };
      run(): Promise<{ success: boolean }>;
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
    };
  };
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/roundtrip") {
      await env.DB.exec(
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      );
      await env.DB.prepare("DELETE FROM users").run();
      await env.DB.prepare("INSERT INTO users (name) VALUES (?)").bind("alice").run();
      await env.DB.prepare("INSERT INTO users (name) VALUES (?)").bind("bob").run();
      const all = await env.DB.prepare("SELECT name FROM users ORDER BY name").all<{
        name: string;
      }>();
      const first = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
      return Response.json({
        names: all.results.map((r) => r.name),
        count: first?.n ?? null,
      });
    }
    if (url.pathname === "/tables") {
      const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).all<{ name: string }>();
      return Response.json({ tables: tables.results.map((t) => t.name) });
    }
    if (url.pathname === "/migrations") {
      const rows = await env.DB.prepare(
        "SELECT id, name FROM __alchemy_migrations ORDER BY id",
      ).all<{ id: string; name: string }>();
      return Response.json({ migrations: rows.results });
    }
    if (url.pathname === "/wipe" && request.method === "POST") {
      // Leaves the database as a deleted `.alchemy/local/d1` would: no tables.
      const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      ).all<{ name: string }>();
      for (const { name } of tables.results) {
        await env.DB.exec(`DROP TABLE "${name}"`);
      }
      return Response.json({ dropped: tables.results.map((t) => t.name) });
    }
    if (url.pathname === "/users") {
      const rows = await env.DB.prepare("SELECT name FROM users ORDER BY name").all<{
        name: string;
      }>();
      return Response.json({ users: rows.results.map((r) => r.name) });
    }
    return new Response("not found", { status: 404 });
  },
};
