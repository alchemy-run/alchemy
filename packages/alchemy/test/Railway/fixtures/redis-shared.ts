import { Redis } from "@/Railway/Redis.ts";
import { Site } from "./bindings-shared.ts";

export { Site };

export const Cache = Redis("Cache", { project: Site });

export const REDIS_KEY = "alchemy-marker";
export const REDIS_VALUE = "hello-from-redis";
