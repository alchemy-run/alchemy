import { createPhysicalName } from "../../PhysicalName.ts";

/**
 * Generated name for a watcher child (target, alert rule link, shared
 * private link). Children cannot be tagged, so a generated name is the
 * ownership marker.
 */
export const createWatcherChildName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true, delimiter: "-" });
