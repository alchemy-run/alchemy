import * as Layer from "effect/Layer";
import {
  ContainerGroupPool,
  ContainerGroupPoolProvider,
} from "./ContainerGroupPool.ts";
import {
  VirtualMachinePool,
  VirtualMachinePoolProvider,
} from "./VirtualMachinePool.ts";

export const resources = [ContainerGroupPool, VirtualMachinePool];
export const layers = () =>
  Layer.mergeAll(ContainerGroupPoolProvider(), VirtualMachinePoolProvider());
