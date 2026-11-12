import { ledgerLive } from "../ledger-live.ts";
import { Default } from "./cluster.ts";

export default ledgerLive(import.meta.url, Default);
