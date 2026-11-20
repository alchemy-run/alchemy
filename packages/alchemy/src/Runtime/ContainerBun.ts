import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "../Http.ts";

export const services = BunServices.layer;
export const httpServer = BunHttpServer();
