import type { Workflow } from "@cloudflare/workers-types";

export default {
  async fetch(
    request: Request,
    env: { VALIDATION_WORKFLOW: Workflow<{ value: string }> },
  ) {
    const path = new URL(request.url).pathname;
    if (path === "/start") {
      try {
        const instance = await env.VALIDATION_WORKFLOW.create({
          params: { value: "workflow-export-ok" },
        });
        return Response.json({ instanceId: instance.id });
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    }
    if (path.startsWith("/status/")) {
      const instance = await env.VALIDATION_WORKFLOW.get(
        path.slice("/status/".length),
      );
      return Response.json(await instance.status());
    }
    return new Response("workflow-export-ready");
  },
};
