import { counterLive } from "../counter-live.ts";
import { Default } from "./cluster.ts";

export default counterLive(import.meta.url, Default);
