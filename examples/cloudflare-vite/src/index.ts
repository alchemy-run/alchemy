import { Hono } from "hono";

// TODO: looks like openauth imports node:fs ...
// import { issuer } from "./auth/issuer";

export const api = new Hono();

api.get("/hello", (c) => c.text("Hello World"));

export default {
  async fetch(request: Request): Promise<Response> {
    return api.fetch(request);
  },
};
