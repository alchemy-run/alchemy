import { One } from "./cluster.ts";
import { replicaLive } from "./replica-live.ts";

export default replicaLive(import.meta.url, One);
