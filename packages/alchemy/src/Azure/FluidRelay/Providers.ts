import * as Layer from "effect/Layer";
import { Server, ServerProvider } from "./Server.ts";

export const resources = [Server];
export const layers = () => Layer.mergeAll(ServerProvider());
