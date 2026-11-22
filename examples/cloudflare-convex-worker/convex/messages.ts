// convex/messages.ts
import * as Convex from "@alchemy.run/convex/Server";
import { MessagesLive } from "../src/messages.live.ts";
import { AddMessage, ListMessages } from "../src/messages.ts";

export const list = Convex.serve(ListMessages, MessagesLive);
export const add = Convex.serve(AddMessage, MessagesLive);
