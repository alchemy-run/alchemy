import * as Convex from "@alchemy.run/convex/Server";
import { MessagesLive } from "../src/messages.live.ts";
import {
  AddMessage,
  AddThenFail,
  GetMessage,
  ListMessages,
  MarkDelivered,
  Summarize,
  WhoAmI,
} from "../src/messages.ts";

export const list = Convex.serve(ListMessages, MessagesLive);
export const get = Convex.serve(GetMessage, MessagesLive);
export const add = Convex.serve(AddMessage, MessagesLive);
export const addThenFail = Convex.serve(AddThenFail, MessagesLive);
export const markDelivered = Convex.serve(MarkDelivered, MessagesLive);
export const summarize = Convex.serve(Summarize, MessagesLive);
export const whoami = Convex.serve(WhoAmI, MessagesLive);
