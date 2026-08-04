/**
 * Minimal worker for the credential-free `alchemy dev` proof
 * (test/credential-free.test.ts): one KV roundtrip so a local resource
 * binding is exercised, one marker response so the test can assert the
 * worker actually served.
 *
 * NOTE: the default export must be this module's ONLY export — extra named
 * exports become workerd top-level exports and fail startup validation.
 */
interface KVLite {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

export default {
  async fetch(_request: Request, env: { KV: KVLite }): Promise<Response> {
    await env.KV.put("greeting", "hello from credential-free dev");
    const value = await env.KV.get("greeting");
    return Response.json({ marker: "credential-free-ok", value });
  },
};
