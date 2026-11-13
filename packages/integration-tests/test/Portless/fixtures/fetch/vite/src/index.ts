// A Vite-hosted Worker: the same plain handler, built and served by the Vite dev server.
interface Env {
  API_URL: string;
}

export default {
  fetch: async (_request: Request, env: Env) => {
    try {
      return await fetch(`${env.API_URL}/hello`);
    } catch (error) {
      return new Response(`caller failed: ${String(error)}`, { status: 500 });
    }
  },
};
