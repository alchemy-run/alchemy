import * as Layer from "effect/Layer";
import { Workflow, WorkflowProvider } from "./Workflow.ts";

export const resources = [Workflow];
export const layers = () => Layer.mergeAll(WorkflowProvider());
