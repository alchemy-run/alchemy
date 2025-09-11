import type { analytics } from "../alchemy.run.js";

export default {
  fetch: async (req, env) => {
    const bearer = req.headers.get("Authorization");
    if (bearer !== `Bearer ${env.API_KEY}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response("Welcome, you are authorized!");
  },
} as ExportedHandler<typeof analytics.Env>;
