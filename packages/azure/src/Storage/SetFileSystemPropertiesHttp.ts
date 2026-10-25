import * as Layer from "effect/Layer";
import {
  DataLakeAccess,
  makeSetFileSystemPropertiesClient,
  makeFileSystemBinding,
} from "./DataLakeBindingHttp.ts";
import { SetFileSystemProperties } from "./SetFileSystemProperties.ts";

/**
 * Implementation of {@link SetFileSystemProperties} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `containers/read` and `containers/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.SetFileSystemProperties
 */
export const SetFileSystemPropertiesHttp = Layer.effect(
  SetFileSystemProperties,
  makeFileSystemBinding({
    tag: "Azure.Storage.SetFileSystemProperties",
    access: DataLakeAccess.fileSystemWrite,
    makeClient: makeSetFileSystemPropertiesClient,
  }),
);
