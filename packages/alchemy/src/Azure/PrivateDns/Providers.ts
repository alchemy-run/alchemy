import * as Layer from "effect/Layer";
import { RecordSet, RecordSetProvider } from "./RecordSet.ts";
import {
  VirtualNetworkLink,
  VirtualNetworkLinkProvider,
} from "./VirtualNetworkLink.ts";
import { Zone, ZoneProvider } from "./Zone.ts";

export const resources = [RecordSet, VirtualNetworkLink, Zone];
export const layers = () =>
  Layer.mergeAll(
    RecordSetProvider(),
    VirtualNetworkLinkProvider(),
    ZoneProvider(),
  );
