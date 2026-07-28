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
        const body = await request.json<Message["body"]>();
        const queue = await env.QUEUE.send(body);
        return Response.json({ queue });
      }
      case "/queue/messages": {
        const storage = env.MESSAGES.getByName("global");
        const messages = await storage.list();
        return Response.json(messages);
      }
      case "/counter": {
        const counter = env.COUNTER.getByName("my-counter");
        const count = await counter.increment();
        return new Response(`Hello, world! ${count}`);
      }
      case "/r2": {
        await env.BUCKET.put("hello.txt", "hello from r2");
        const object = await env.BUCKET.get("hello.txt");
        const text = object === null ? null : await object.text();
        const list = await env.BUCKET.list();
        return Response.json({
          text,
          keys: list.objects.map((o) => o.key),
        });
      }
      case "/d1": {
        await env.DB.exec(
          "CREATE TABLE IF NOT EXISTS greetings (id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
        );
        await env.DB.prepare("INSERT INTO greetings (text) VALUES (?)")
          .bind("hello from d1")
          .run();
        const row = await env.DB.prepare(
          "SELECT text FROM greetings ORDER BY id DESC LIMIT 1",
        ).first<{ text: string }>();
        return Response.json({ text: row?.text ?? null });
      }
      default:
        return env.ASSETS.fetch(request);
    }
  },
  async queue(batch, env) {
    const storage = env.MESSAGES.getByName("global");
    for (const message of batch.messages) {
      await storage.put({
        id: message.id,
        body: message.body as Message["body"],
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

export interface Message {
  id: string;
  body: {
    text: string;
    sentAt: number;
  };
}

export class QueueMessages extends DurableObject {
  async put(message: Message) {
    this.ctx.storage.kv.put(message.id, message);
  }

  async list(): Promise<Message[]> {
    const messages = new Map(this.ctx.storage.kv.list<Message>());
    return Array.from(messages.values());
  }
}
