import { env } from "cloudflare:workers";

globalThis.process.env = env;
