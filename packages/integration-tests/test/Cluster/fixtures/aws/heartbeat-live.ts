import { heartbeatLive } from "../scheduled/heartbeat-live.ts";
import { Default } from "./cluster.ts";

export default heartbeatLive(import.meta.url, Default);
