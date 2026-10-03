import * as Layer from "effect/Layer";
import { Bot, BotProvider } from "./Bot.ts";
import { Channel, ChannelProvider } from "./Channel.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";

export const resources = [Bot, Channel, Connection];
export const layers = () =>
  Layer.mergeAll(BotProvider(), ChannelProvider(), ConnectionProvider());
