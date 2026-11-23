"use node";

import * as Convex from "@alchemy.run/convex/Server";
import { OutboxLive } from "../src/outbox.live.ts";
import { Publish } from "../src/outbox.ts";

export const publish = Convex.serve(Publish, OutboxLive);
