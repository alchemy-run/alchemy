import type { queue, worker } from "../alchemy.run";

export default {
  async fetch(request: Request, env: typeof worker.Env) {
    await env.QUEUE.send({
      name: "John Doe",
      email: "john.doe@example.com",
    });
    return new Response("Ok");
  },
  async queue(batch: typeof queue.Batch, env: typeof worker.Env) {
    for (const message of batch.messages) {
      console.log(message);
      message.ack();
    }
    batch.ackAll();
  },
};
