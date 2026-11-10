import { approveLive } from "../workflows/approve-live.ts";
import { Default } from "./cluster.ts";

export default approveLive(import.meta.url, Default);
