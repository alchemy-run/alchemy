export default {
  fetch: async (_request: Request, env: Record<string, unknown>) => {
    return new Response(
      JSON.stringify({
        NUM: env.NUM,
        BOOL: env.BOOL,
        OBJ: env.OBJ,
        ARR: env.ARR,
        STR: env.STR,
        types: {
          NUM: typeof env.NUM,
          BOOL: typeof env.BOOL,
          OBJ: typeof env.OBJ,
          ARR: Array.isArray(env.ARR) ? "array" : typeof env.ARR,
          STR: typeof env.STR,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
