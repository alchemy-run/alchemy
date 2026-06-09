import { DurableObject } from "cloudflare:workers";
import type { AsyncWorkerEnv } from "../alchemy.run.ts";
import wasm from "./modules/wasm-example.wasm";

interface AddInstance {
  exports: {
    add(a: number, b: number): number;
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/env":
        return Response.json(env);
      case "/wasm":
        const instance = (await WebAssembly.instantiate(wasm)) as AddInstance;
        return Response.json({ result: instance.exports.add(3, 4) });
      case "/queue/send": {
        const body = await request.json<QueueMessage["body"]>();
        const queue = await env.QUEUE.send(body);
        return Response.json({ queue });
      }
      case "/queue/messages": {
        const storage = env.MESSAGES.getByName("global");
        const messages = await storage.list();
        return Response.json(messages);
      }
      default:
        const counter = env.COUNTER.getByName("my-counter");
        const count = await counter.increment();
        return new Response(`Hello, world! ${count}`);
    }
  },
  async queue(batch, env) {
    const storage = env.MESSAGES.getByName("global");
    for (const message of batch.messages) {
      await storage.put({
        id: message.id,
        body: message.body as QueueMessage["body"],
      });
    }
  },
} satisfies ExportedHandler<AsyncWorkerEnv>;

export class Counter extends DurableObject {
  async increment() {
    return ++this.counter;
  }

  get counter() {
    return this.ctx.storage.kv.get<number>("counter") ?? 0;
  }

  set counter(value: number) {
    this.ctx.storage.kv.put("counter", value);
  }
}

export interface QueueMessage {
  id: string;
  body: {
    text: string;
    sentAt: number;
  };
}

export class QueueMessages extends DurableObject {
  async put(message: QueueMessage) {
    this.ctx.storage.kv.put(message.id, message);
  }

  async list(): Promise<QueueMessage[]> {
    const messages = new Map(this.ctx.storage.kv.list<QueueMessage>());
    return Array.from(messages.values());
  }
}
