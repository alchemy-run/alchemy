import { Hono } from "hono";
import type { CloudflareEnv } from "./env.ts";

export const api = new Hono<{ Bindings: CloudflareEnv }>();

api.get("/hello", (c) => c.text(c.env.ALCHEMY_TEST_VALUE));

export default api;
