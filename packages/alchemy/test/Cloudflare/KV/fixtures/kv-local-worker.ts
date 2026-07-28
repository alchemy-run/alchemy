// Async (non-Effect) Worker that exercises the native KV binding against
// the local workerd simulator: put / get / getWithMetadata / list / delete.
interface Env {
  KV: {
    put(
      key: string,
      value: string,
      options?: { metadata?: unknown },
    ): Promise<void>;
    get(key: string): Promise<string | null>;
    getWithMetadata(
      key: string,
    ): Promise<{ value: string | null; metadata: unknown }>;
    list(): Promise<{ keys: Array<{ name: string }> }>;
    delete(key: string): Promise<void>;
  };
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/roundtrip") {
      await env.KV.put("key1", "value1");
      await env.KV.put("key2", "value2", { metadata: { hello: "world" } });
      const value = await env.KV.get("key1");
      const { value: value2, metadata } = await env.KV.getWithMetadata("key2");
      const list = await env.KV.list();
      await env.KV.delete("key1");
      const afterDelete = await env.KV.get("key1");
      return Response.json({
        value,
        value2,
        metadata,
        keys: list.keys.map((k) => k.name),
        afterDelete,
      });
    }
    return new Response("not found", { status: 404 });
  },
};
