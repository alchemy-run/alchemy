import * as Archil from "@/Archil/index.ts";

/** Shared disk fixture bound into the Worker and Lambda exec fixtures. */
export const WorkerDisk = Archil.Disk("ArchilWorkerDisk");

export const LambdaDisk = Archil.Disk("ArchilLambdaDisk");
