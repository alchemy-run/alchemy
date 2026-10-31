// A plain Worker: the service's origin arrives as an env value and the call is a `fetch`.
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
