import * as Layer from "effect/Layer";
import { RecordSet, RecordSetProvider } from "./RecordSet.ts";
import { Zone, ZoneProvider } from "./Zone.ts";

export const resources = [RecordSet, Zone];
export const layers = () => Layer.mergeAll(RecordSetProvider(), ZoneProvider());
