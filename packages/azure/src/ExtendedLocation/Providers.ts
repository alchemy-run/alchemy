import * as Layer from "effect/Layer";
import { CustomLocation, CustomLocationProvider } from "./CustomLocation.ts";

export const resources = [CustomLocation];
export const layers = () => Layer.mergeAll(CustomLocationProvider());
