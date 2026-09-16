/// <reference types="@cloudflare/workers-types" />
export default {
  async fetch(request: Request, env: { INDEX: Vectorize }): Promise<Response> {
    const { method, args } = await request.json<{
      method:
        | "describe"
        | "upsert"
        | "query"
        | "queryById"
        | "getByIds"
        | "deleteByIds";
      args: unknown[];
    }>();
    try {
      const operation = env.INDEX[method] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      return Response.json(await operation.apply(env.INDEX, args));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  },
};
