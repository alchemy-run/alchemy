import * as Layer from "effect/Layer";
import {
  DataLakeAccess,
  makeSetPathPropertiesClient,
  makeFileSystemBinding,
} from "./DataLakeBindingHttp.ts";
import { SetPathProperties } from "./SetPathProperties.ts";

/**
 * Implementation of {@link SetPathProperties} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `blobs/write` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.SetPathProperties
 */
export const SetPathPropertiesHttp = Layer.effect(
  SetPathProperties,
  makeFileSystemBinding({
    tag: "Azure.Storage.SetPathProperties",
    access: DataLakeAccess.write,
    makeClient: makeSetPathPropertiesClient,
  }),
);
