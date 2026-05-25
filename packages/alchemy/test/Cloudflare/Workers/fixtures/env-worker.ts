export default {
  fetch: async (_request: Request, env: Record<string, unknown>) => {
    return new Response(
      JSON.stringify({
        STR: env.STR,
        NUM: env.NUM,
        BOOL: env.BOOL,
        OBJ: env.OBJ,
        ARR: env.ARR,
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
