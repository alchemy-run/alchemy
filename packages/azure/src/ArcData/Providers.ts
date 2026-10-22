import * as Layer from "effect/Layer";
import { DataController, DataControllerProvider } from "./DataController.ts";

export const resources = [DataController];
export const layers = () => Layer.mergeAll(DataControllerProvider());
