import { NodeServices } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { NodeHttpServer } from "../Http.ts";
import { TerminalsNode } from "./TerminalNode.ts";

export const services = Layer.merge(NodeServices.layer, TerminalsNode);
export const httpServer = NodeHttpServer();
