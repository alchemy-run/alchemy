import { parentLive } from "../workflows/parent-live.ts";
import { Default } from "./cluster.ts";

export default parentLive(import.meta.url, Default);
