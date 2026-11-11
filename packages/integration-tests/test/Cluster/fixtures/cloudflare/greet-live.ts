import { greetLive } from "../workflows/greet-live.ts";
import { Default } from "./cluster.ts";

export default greetLive(import.meta.url, Default);
