import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as Layer from "effect/Layer";
import { makeFileHttpBinding } from "./BindingHttp.ts";
import { GetFile } from "./GetFile.ts";

/**
 * HTTP implementation of {@link GetFile}.
 *
 * @layer
 * @provides GCP.Drive.GetFile
 */
export const GetFileHttp = Layer.effect(
  GetFile,
  makeFileHttpBinding({
    tag: "GCP.Drive.GetFile",
    operation: drive.getFiles,
  }),
);
