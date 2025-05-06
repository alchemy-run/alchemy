import hooks from "node:async_hooks";

export default {
  async fetch(): Promise<Response> {
    return new Response(typeof hooks.AsyncLocalStorage);
  },
};
