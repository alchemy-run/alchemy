import type * as drive from "@distilled.cloud/gcp/drive_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { File } from "./File.ts";

export interface GetFileRequest extends Omit<drive.GetFilesRequest, "fileId"> {}

/**
 * Runtime binding for Drive `files.get`.
 *
 * Bind this operation to a {@link File} in a Function/Action init phase.
 * Provide {@link GetFileHttp}.
 *
 * ### Reading Files
 * **Example:** Read file metadata
 * ```typescript
 * const getFile = yield* GCP.Drive.GetFile(file);
 * const metadata = yield* getFile({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Drive
 */
export interface GetFile extends Binding.Service<
  GetFile,
  "GCP.Drive.GetFile",
  (
    file: File,
  ) => Effect.Effect<
    (
      request: GetFileRequest,
    ) => Effect.Effect<drive.File, drive.GetFilesError, RuntimeContext>
  >
> {}

export const GetFile = Binding.Service<GetFile>("GCP.Drive.GetFile");
