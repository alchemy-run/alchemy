import { Private } from "./cluster.ts";
import { waiterLive } from "./waiter-live.ts";
import { PrivateWaiters } from "./waiter.ts";

export default waiterLive(PrivateWaiters, import.meta.url, Private);
