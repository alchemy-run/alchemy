/// <reference types="@cloudflare/workers-types" />
export default {
  async fetch(request: Request, env: { FLAGS: Flagship; REVISION: string }) {
    if (request.method !== "POST") return new Response(env.REVISION);
    const { method, key, fallback, context } = (await request.json()) as {
      method: keyof Flagship;
      key: string;
      fallback: unknown;
      context?: FlagshipEvaluationContext;
    };
    const binding = env.FLAGS as unknown as Record<
      string,
      (
        key: string,
        fallback: unknown,
        context?: FlagshipEvaluationContext,
      ) => Promise<unknown>
    >;
    return Response.json(await binding[method]!(key, fallback, context));
  },
};
