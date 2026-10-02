import * as Layer from "effect/Layer";
import { ContainerGroup, ContainerGroupProvider } from "./ContainerGroup.ts";
import {
  ContainerGroupProfile,
  ContainerGroupProfileProvider,
} from "./ContainerGroupProfile.ts";
import { NGroup, NGroupProvider } from "./NGroup.ts";
import { SandboxGroup, SandboxGroupProvider } from "./SandboxGroup.ts";

export const resources = [
  ContainerGroup,
  ContainerGroupProfile,
  NGroup,
  SandboxGroup,
];
export const layers = () =>
  Layer.mergeAll(
    ContainerGroupProvider(),
    ContainerGroupProfileProvider(),
    NGroupProvider(),
    SandboxGroupProvider(),
  );
