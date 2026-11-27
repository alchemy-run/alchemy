import { Secure } from "./cluster.ts";
import { waiterLive } from "./waiter-live.ts";
import { SecureWaiters } from "./waiter.ts";

export default waiterLive(SecureWaiters, import.meta.url, Secure);
