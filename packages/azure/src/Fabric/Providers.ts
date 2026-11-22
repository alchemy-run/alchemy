import * as Layer from "effect/Layer";
import { Capacity, CapacityProvider } from "./Capacity.ts";

export const resources = [Capacity];
export const layers = () => Layer.mergeAll(CapacityProvider());
