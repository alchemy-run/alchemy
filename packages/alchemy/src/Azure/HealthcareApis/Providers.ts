import * as Layer from "effect/Layer";
import { DicomService, DicomServiceProvider } from "./DicomService.ts";
import { FhirService, FhirServiceProvider } from "./FhirService.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [DicomService, FhirService, Workspace];
export const layers = () =>
  Layer.mergeAll(
    DicomServiceProvider(),
    FhirServiceProvider(),
    WorkspaceProvider(),
  );
