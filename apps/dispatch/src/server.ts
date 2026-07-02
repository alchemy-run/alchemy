import index from "./ui/index.html";
import { orchestrator, WORKSPACE_ROOT } from "./orchestrator.ts";
import { store } from "./store.ts";
import { taskManager } from "./tasks.ts";

const PORT = Number(process.env.PORT ?? 5170);

orchestrator.start();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(): Response {
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      send(store.snapshot());
      unsubscribe = store.subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);
    },
    cancel() {
      unsubscribe();
      clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: {
    "/": index,

    "/api/stream": () => sseResponse(),

    "/api/message": {
      POST: async (req) => {
        const body = (await req.json()) as { text?: string };
        const text = body.text?.trim();
        if (!text) return json({ error: "text required" }, 400);
        orchestrator.sendUserMessage(text);
        return json({ ok: true }, 202);
      },
    },

    "/api/tasks/:id/answer": {
      POST: async (req) => {
        const body = (await req.json()) as { questionId?: string; value?: string };
        if (!body.questionId || !body.value) {
          return json({ error: "questionId and value required" }, 400);
        }
        const ok = taskManager.answer(req.params.id, body.questionId, body.value);
        return json({ ok }, ok ? 200 : 404);
      },
    },

    "/api/tasks/:id/message": {
      POST: async (req) => {
        const body = (await req.json()) as { text?: string };
        if (!body.text?.trim()) return json({ error: "text required" }, 400);
        const ok = taskManager.message(req.params.id, body.text.trim(), "user");
        return json({ ok }, ok ? 200 : 404);
      },
    },

    "/api/tasks/:id/stop": {
      POST: async (req) => {
        const ok = await taskManager.stop(req.params.id);
        return json({ ok }, ok ? 200 : 404);
      },
    },

    "/api/tasks/:id": (req) => {
      const card = taskManager.get(req.params.id);
      return card ? json(card) : json({ error: "not found" }, 404);
    },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true },
});

console.log(`
  ⣿ Dispatch — one agent for all your threads

  UI:        http://localhost:${server.port}
  Workspace: ${WORKSPACE_ROOT}

  Talking to the orchestrator spawns Claude Code worker sessions in the
  workspace. Set DISPATCH_WORKSPACE=/path/to/repo to point elsewhere.
`);
