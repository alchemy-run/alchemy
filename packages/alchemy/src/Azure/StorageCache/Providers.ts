import * as Layer from "effect/Layer";
import { AmlFilesystem, AmlFilesystemProvider } from "./AmlFilesystem.ts";
import { AutoExportJob, AutoExportJobProvider } from "./AutoExportJob.ts";
import { AutoImportJob, AutoImportJobProvider } from "./AutoImportJob.ts";

export const resources = [AmlFilesystem, AutoExportJob, AutoImportJob];
export const layers = () =>
  Layer.mergeAll(
    AmlFilesystemProvider(),
    AutoExportJobProvider(),
    AutoImportJobProvider(),
  );
