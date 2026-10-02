import * as Layer from "effect/Layer";
import { IpPrefix, IpPrefixProvider } from "./IpPrefix.ts";

export const resources = [IpPrefix];
export const layers = () => Layer.mergeAll(IpPrefixProvider());
