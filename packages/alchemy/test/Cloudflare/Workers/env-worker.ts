export default {
  fetch: async (_request: Request, env: Record<string, string>) => {
    // Non-string env values arrive as JSON-encoded strings — the SDK
    // serialises them via `type: "json"` bindings whose `json` field
    // must be a string per the OpenAPI schema. Cloudflare does not
    // auto-parse on the way out, so consumers `JSON.parse` here.
    return new Response(
      JSON.stringify({
        STR: env.STR,
        NUM: JSON.parse(env.NUM),
        BOOL: JSON.parse(env.BOOL),
        OBJ: JSON.parse(env.OBJ),
        ARR: JSON.parse(env.ARR),
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
