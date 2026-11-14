export default {
  async fetch(request: Request, env: Record<string, string | undefined>) {
    return new Response(`${env.GREETING} ${new URL(request.url).pathname}`, {
      headers: { "content-type": "text/plain" },
    });
  },
};
