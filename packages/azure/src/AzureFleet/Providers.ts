import * as Layer from "effect/Layer";
import { Fleet, FleetProvider } from "./Fleet.ts";

export const resources = [Fleet];
export const layers = () => Layer.mergeAll(FleetProvider());
