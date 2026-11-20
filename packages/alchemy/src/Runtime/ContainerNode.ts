import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "../Http.ts";

export const services = NodeServices.layer;
export const httpServer = NodeHttpServer();
