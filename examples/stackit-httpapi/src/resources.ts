import * as Stackit from "@alchemy.run/stackit";

/** One JSON object per task. A destroy deletes what is left in it. */
export const Tasks = Stackit.ObjectStorage.Bucket("Tasks", { forceDestroy: true });
