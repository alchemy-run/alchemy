import fs from "node:fs/promises";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new Response(typeof fs.readFile);
  },
};
