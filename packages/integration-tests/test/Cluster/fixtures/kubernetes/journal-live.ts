import { journalLive } from "../workflows/journal-live.ts";
import { Default } from "./cluster.ts";

export default journalLive(import.meta.url, Default);
