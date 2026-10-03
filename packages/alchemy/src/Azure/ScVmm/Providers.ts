import * as Layer from "effect/Layer";
import { GuestAgent, GuestAgentProvider } from "./GuestAgent.ts";
import {
  VirtualMachineInstance,
  VirtualMachineInstanceProvider,
} from "./VirtualMachineInstance.ts";
import { VmmServer, VmmServerProvider } from "./VmmServer.ts";

export const resources = [GuestAgent, VirtualMachineInstance, VmmServer];
export const layers = () =>
  Layer.mergeAll(
    GuestAgentProvider(),
    VirtualMachineInstanceProvider(),
    VmmServerProvider(),
  );
