import type { worker } from "../alchemy.run";

export default {
  async fetch(request: Request, env: typeof worker.Env) {
    await env.QUEUE.send({
      name: "John Doe",
      email: "john.doe@example.com",
    });
    return new Response("Ok");
  },
  // TODO: what is the type of batch?
  async queue(batch: any, env: typeof worker.Env) {
    console.log(batch);
  },
};
