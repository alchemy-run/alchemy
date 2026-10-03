import * as Layer from "effect/Layer";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [Workspace];
export const layers = () => Layer.mergeAll(WorkspaceProvider());
