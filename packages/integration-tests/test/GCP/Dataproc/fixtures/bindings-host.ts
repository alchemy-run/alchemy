import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";
import { serveProbes } from "../../bindingHost.ts";
import { CAPACITY_REGION } from "../../zones.ts";

/**
 * Cluster the bindings target: GetCluster is granted on it
 * (roles/dataproc.viewer), SubmitJob on the project (roles/dataproc.editor).
 */
export const Jobs = Effect.gen(function* () {
  const project = yield* deployProject;
  // Its own worker account: the project's default compute account may lack
  // the storage access Dataproc needs on its staging bucket.
  const workers = yield* GCP.IAM.ServiceAccount("JobsWorkers", {});
  const role = yield* GCP.IAM.Member("JobsWorkersRole", {
    kind: "project",
    name: project,
    role: "roles/dataproc.worker",
    member: Output.interpolate`serviceAccount:${workers.email}`,
  });
  return yield* GCP.Dataproc.Cluster("Jobs", {
    region: CAPACITY_REGION,
    // No zone: Dataproc Auto Zone Placement picks a zone in the region with
    // capacity, so a single-zone stockout cannot fail the deploy.
    // Through the grant, so the role exists before any VM boots.
    serviceAccount: Output.all(workers.email, role.role).pipe(Output.map(([email]) => email)),
  });
});

/**
 * Effect-native Cloud Run service exercising every Dataproc binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class DataprocBindingsHost extends GCP.Function<DataprocBindingsHost>()(
  "DataprocBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getCluster = yield* GCP.Dataproc.GetCluster(Jobs);
    const submitJob = yield* GCP.Dataproc.SubmitJob(Jobs);

    return {
      fetch: serveProbes({
        getCluster: getCluster(),
        submitJob: submitJob({
          body: { job: { pigJob: { queryList: { queries: ["DUMP;"] } } } },
        }),
      }),
    };
  }).pipe(Effect.provide(GCP.Dataproc.GetClusterHttp), Effect.provide(GCP.Dataproc.SubmitJobHttp)),
) {}
