import fs from "node:fs/promises";

export default {
  async fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return new Response(typeof fs.readFile);
  },
};
