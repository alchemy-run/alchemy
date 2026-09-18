import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { AsyncWorkflowEnv } from "./stack.ts";

interface Params {
  value: string;
}

// Plain (non-Effect) Workflow class hosted by an async Worker. Bound to the
// Worker via `env.MY_WORKFLOW` using the props-only `Cloudflare.Workflow`
// reference form — the analogue of binding a class-based Durable Object.
export class MyWorkflow extends WorkflowEntrypoint<AsyncWorkflowEnv, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
    const greeting = await step.do(
      "greet",
      async () => `Hello, ${event.payload.value}!`,
    );

    await step.sleep("cooldown", "1 second");

    return await step.do("finalize", async () => ({
      greeting,
      workflowName: event.workflowName,
    }));
  }
}

export class WorkflowEvents extends DurableObject {
  async record(id: string, body: unknown) {
    await this.ctx.storage.put(id, body);
  }

  async events() {
    return Array.from((await this.ctx.storage.list()).values());
  }
}

export default {
  async queue(batch: MessageBatch, env: AsyncWorkflowEnv) {
    const events = env.EVENTS.getByName("events");
    for (const message of batch.messages) {
      await events.record(message.id, message.body);
    }
  },

  async fetch(
    request: Request,
    env: AsyncWorkflowEnv & { WORKFLOW_SCRIPT_NAME?: string },
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/events") {
      return Response.json(await env.EVENTS.getByName("events").events());
    }
    if (url.pathname === "/env") {
      return Response.json({
        greeting: env.GREETING,
        config: env.CONFIG,
        effect: env.EFFECT,
        output: env.OUTPUT,
        asset: await (
          await env.ASSETS.fetch(new URL("/test.txt", request.url))
        ).text(),
      });
    }
    if (url.pathname === "/workflow/script-name") {
      return new Response(env.WORKFLOW_SCRIPT_NAME);
    }

    if (url.pathname.startsWith("/workflow/start/")) {
      const value = url.pathname.split("/workflow/start/")[1] ?? "world";
      const instance = await env.MY_WORKFLOW.create({ params: { value } });
      return Response.json({ instanceId: instance.id });
    }

    if (url.pathname.startsWith("/workflow/status/")) {
      const id = url.pathname.split("/workflow/status/")[1] ?? "";
      const instance = await env.MY_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }

    return new Response("ok");
  },
};
