import * as Layer from "effect/Layer";
import { Ledger, LedgerProvider } from "./Ledger.ts";

export const resources = [Ledger];
export const layers = () => Layer.mergeAll(LedgerProvider());
