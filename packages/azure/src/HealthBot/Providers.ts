import * as Layer from "effect/Layer";
import { Bot, BotProvider } from "./Bot.ts";

export const resources = [Bot];
export const layers = () => Layer.mergeAll(BotProvider());
