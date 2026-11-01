import * as Stackit from "@alchemy.run/stackit";

/** The files the API stores, one object per key. A destroy deletes what is left in it. */
export const Files = Stackit.ObjectStorage.Bucket("Files", { forceDestroy: true });
