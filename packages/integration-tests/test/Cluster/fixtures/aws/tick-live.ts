import { tickLive } from "../scheduled/tick-live.ts";
import { Default } from "./cluster.ts";

export default tickLive(import.meta.url, Default);
