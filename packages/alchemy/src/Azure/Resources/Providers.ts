import * as Layer from "effect/Layer";
import { ResourceGroup, ResourceGroupProvider } from "./ResourceGroup.ts";

export const resources = [ResourceGroup];
export const layers = () => Layer.mergeAll(ResourceGroupProvider());
