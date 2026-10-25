import type { ApiEnv } from "./plain.ts";

// #region show
// @slide import type { ApiEnv } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: ApiEnv) {
    const obj = await env.Uploads.get("hello.txt");
    return obj
      ? new Response(await obj.text())
      : new Response("Not found", { status: 404 });
  },
};
// #endregion show
