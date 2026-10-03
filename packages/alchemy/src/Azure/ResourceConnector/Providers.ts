import * as Layer from "effect/Layer";
import { Appliance, ApplianceProvider } from "./Appliance.ts";

export const resources = [Appliance];
export const layers = () => Layer.mergeAll(ApplianceProvider());
