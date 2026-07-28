import * as Archil from "@/Archil/index.ts";

/**
 * Disks declared at module scope and imported by the host fixtures — the
 * same shape as the R2 binding fixtures' shared `TestBucket`. Passing the
 * resource straight to `archil.disk(...)` is what the hosts exercise.
 */
export const WorkerDisk = Archil.Disk("WorkerDisk");

export const LambdaDisk = Archil.Disk("LambdaDisk");
