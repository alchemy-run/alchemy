import { BunServices } from "@effect/platform-bun";
import * as Layer from "effect/Layer";
import { BunHttpServer } from "../Http.ts";
import { TerminalsBun } from "./TerminalBun.ts";

export const services = Layer.merge(BunServices.layer, TerminalsBun);
export const httpServer = BunHttpServer();
