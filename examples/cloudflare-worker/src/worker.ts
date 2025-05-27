import type { queue, worker } from "../alchemy.run.js";
export * from "./do.js";
export * from "./workflow.js";

export default {
  async fetch(_request: Request, env: typeof worker.Env) {
    await env.QUEUE.send({
      name: "John Doe",
      email: "john.doe@example.com",
    });

    const obj = env.DO.get(env.DO.idFromName("foo"));
    await obj.hello();
    await obj.hello();
    async function _foo() {
      // @ts-expect-error - foo doesn't exist on the HelloWorldDO class
      await obj.foo();
    }
    await obj.fetch(new Request("https://example.com"));

    return new Response("Ok");
  },
  async queue(batch: typeof queue.Batch, _env: typeof worker.Env) {
    for (const message of batch.messages) {
      console.log(message);
      message.ack();
    }
    batch.ackAll();
  },
};
