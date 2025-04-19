import { Hono } from "hono";

export const api = new Hono();

// TODO: more involved API
api.get("/hello", (c) => c.text("Hello World"));
