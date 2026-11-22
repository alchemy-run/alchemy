import * as Layer from "effect/Layer";
import { Instance, InstanceProvider } from "./Instance.ts";

export const resources = [Instance];
export const layers = () => Layer.mergeAll(InstanceProvider());
