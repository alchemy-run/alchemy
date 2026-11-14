import { napLive } from "../workflows/nap-live.ts";
import { Default } from "./cluster.ts";

export default napLive(import.meta.url, Default);
