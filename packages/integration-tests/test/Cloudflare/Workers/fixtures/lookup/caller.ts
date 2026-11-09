// Async Worker that calls a looked-up Worker through a service binding
// (`TARGET`) and a named-entrypoint binding (`API`).
interface Env {
  TARGET: { fetch(input: string): Promise<Response> };
  API: { greet(name: string): Promise<string> };
}

export default {
  fetch: async (_request: Request, env: Env) => {
    try {
      const page = await (await env.TARGET.fetch("https://target/")).text();
      return new Response(`${page} | ${await env.API.greet("alice")}`);
    } catch (err) {
      return new Response(`caller failed: ${String(err)}`, { status: 500 });
    }
  },
};
