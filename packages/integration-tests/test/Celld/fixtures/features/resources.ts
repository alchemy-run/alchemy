import * as Celld from "@alchemy.run/celld";

/**
 * Two nodes behind the fleet's public ingress: the suite drives every
 * native feature over plain HTTP on the load balancer's hostname.
 */
export class FeatureCells extends Celld.Fleet<FeatureCells>()("FeatureCells", {
  instances: 2,
  ingress: true,
}) {}

export const Observations = Celld.KV.Namespace("Observations");
export const Files = Celld.R2.Bucket("Files");
export const Jobs = Celld.Queues.Queue("Jobs");
export const Dead = Celld.Queues.Queue("Dead");
export const Database = Celld.D1.Database("Database", {
  migrations: new URL("./migrations", import.meta.url).pathname,
});

/** The Application entrypoint. */
export class FeatureApi extends Celld.Worker<FeatureApi>()("FeatureApi") {}

/** A secondary Worker reached through a service binding and tail events. */
export class FeatureService extends Celld.Worker<FeatureService>()("FeatureService") {}
