import { Worker } from "../cloudflare/worker.js";

export const messages = await Queue<string>("queue");

export const bucket = await R2Bucket("bucket");

export default Worker("backend", import.meta, {
  async fetch(request: Request) {
    const key = new URL(request.url).pathname;
    await bucket.put(key, request.body);
    await messages.send(key);
    return new Response();
  },
});
