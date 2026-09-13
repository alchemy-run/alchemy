interface Env {
  DISPATCH?: DispatchNamespace;
  VALUE?: string;
}
export default {
  async fetch(request: Request, env: Env) {
    if (!env.DISPATCH)
      return Response.json({
        value: env.VALUE,
        body: await request.text(),
        internalHeader: request.headers.has("MF-Dispatch-Namespace-Options"),
      });
    try {
      return await env.DISPATCH.get(
        new URL(request.url).searchParams.get("worker")!,
      ).fetch(request);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 404 });
    }
  },
};
