import { Edge } from "./cluster.ts";
import { waiterLive } from "./waiter-live.ts";
import { EdgeWaiters } from "./waiter.ts";

export default waiterLive(EdgeWaiters, import.meta.url, Edge);
