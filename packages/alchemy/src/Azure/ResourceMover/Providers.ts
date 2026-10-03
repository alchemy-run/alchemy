import * as Layer from "effect/Layer";
import { MoveCollection, MoveCollectionProvider } from "./MoveCollection.ts";
import { MoveResource, MoveResourceProvider } from "./MoveResource.ts";

export const resources = [MoveCollection, MoveResource];
export const layers = () =>
  Layer.mergeAll(MoveCollectionProvider(), MoveResourceProvider());
