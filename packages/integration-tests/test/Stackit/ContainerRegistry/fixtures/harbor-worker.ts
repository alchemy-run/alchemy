import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

const identity = {
  username: Config.String("STACKIT_TEST_HARBOR_USERNAME"),
  secret: Config.Redacted("STACKIT_TEST_HARBOR_SECRET"),
};

export const Images = Stackit.ContainerRegistry.Project("RegistryHarborBindingsProject", {
  forceDestroy: true,
  harborCredentials: identity,
});

/** One robot holding what every binding below needs. */
export const Robot = Effect.gen(function* () {
  const images = yield* Images;
  return yield* Stackit.ContainerRegistry.RobotAccount("RegistryHarborBindingsRobot", {
    project: images.name,
    registryUrl: images.url,
    credentials: identity,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
      { resource: "repository", action: "list" },
      { resource: "repository", action: "read" },
      { resource: "repository", action: "update" },
      { resource: "repository", action: "delete" },
      { resource: "artifact", action: "list" },
      { resource: "artifact", action: "read" },
      { resource: "artifact", action: "delete" },
      { resource: "artifact-addition", action: "read" },
      { resource: "tag", action: "list" },
      { resource: "tag", action: "create" },
      { resource: "tag", action: "delete" },
      { resource: "scan", action: "create" },
      { resource: "scan", action: "stop" },
      { resource: "scan", action: "read" },
    ],
  });
});

/**
 * A Cloudflare Worker with every binding over the registry's Harbor API. One route
 * per binding; each answers `{ ok, result | error }` so a failure surfaces the
 * registry's error in the test.
 */
export default class RegistryHarborBindingsWorker extends Cloudflare.Worker<RegistryHarborBindingsWorker>()(
  "StackitRegistryHarborBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const robot = yield* Robot;
    const listRepositories = yield* Stackit.ContainerRegistry.ListRepositories(robot);
    const getRepository = yield* Stackit.ContainerRegistry.GetRepository(robot);
    const updateRepository = yield* Stackit.ContainerRegistry.UpdateRepository(robot);
    const deleteRepository = yield* Stackit.ContainerRegistry.DeleteRepository(robot);
    const listArtifacts = yield* Stackit.ContainerRegistry.ListArtifacts(robot);
    const getArtifact = yield* Stackit.ContainerRegistry.GetArtifact(robot);
    const deleteArtifact = yield* Stackit.ContainerRegistry.DeleteArtifact(robot);
    const listTags = yield* Stackit.ContainerRegistry.ListTags(robot);
    const createTag = yield* Stackit.ContainerRegistry.CreateTag(robot);
    const deleteTag = yield* Stackit.ContainerRegistry.DeleteTag(robot);
    const scanArtifact = yield* Stackit.ContainerRegistry.ScanArtifact(robot);
    const stopScan = yield* Stackit.ContainerRegistry.StopScan(robot);
    const getScanReport = yield* Stackit.ContainerRegistry.GetScanReport(robot);
    const getScanLog = yield* Stackit.ContainerRegistry.GetScanLog(robot);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const repository_name = param("repository");
        const reference = param("reference");
        switch (url.pathname) {
          case "/list-repositories":
            return yield* respond(listRepositories({}));
          case "/get-repository":
            return yield* respond(getRepository({ repository_name }));
          case "/update-repository":
            return yield* respond(
              updateRepository({ repository_name, description: param("description") }),
            );
          case "/delete-repository":
            return yield* respond(deleteRepository({ repository_name }));
          case "/list-artifacts":
            return yield* respond(
              listArtifacts({ repository_name, with_tag: true, with_scan_overview: true }),
            );
          case "/get-artifact":
            return yield* respond(getArtifact({ repository_name, reference }));
          case "/delete-artifact":
            return yield* respond(deleteArtifact({ repository_name, reference }));
          case "/list-tags":
            return yield* respond(listTags({ repository_name, reference }));
          case "/create-tag":
            return yield* respond(createTag({ repository_name, reference, name: param("tag") }));
          case "/delete-tag":
            return yield* respond(
              deleteTag({ repository_name, reference, tag_name: param("tag") }),
            );
          case "/scan-artifact":
            return yield* respond(scanArtifact({ repository_name, reference }));
          case "/stop-scan":
            return yield* respond(stopScan({ repository_name, reference }));
          case "/get-scan-report":
            return yield* respond(getScanReport({ repository_name, reference }));
          case "/get-scan-log":
            return yield* respond(
              getScanLog({ repository_name, reference, report_id: param("report") }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ContainerRegistry.ListRepositoriesHttp,
        Stackit.ContainerRegistry.GetRepositoryHttp,
        Stackit.ContainerRegistry.UpdateRepositoryHttp,
        Stackit.ContainerRegistry.DeleteRepositoryHttp,
        Stackit.ContainerRegistry.ListArtifactsHttp,
        Stackit.ContainerRegistry.GetArtifactHttp,
        Stackit.ContainerRegistry.DeleteArtifactHttp,
        Stackit.ContainerRegistry.ListTagsHttp,
        Stackit.ContainerRegistry.CreateTagHttp,
        Stackit.ContainerRegistry.DeleteTagHttp,
        Stackit.ContainerRegistry.ScanArtifactHttp,
        Stackit.ContainerRegistry.StopScanHttp,
        Stackit.ContainerRegistry.GetScanReportHttp,
        Stackit.ContainerRegistry.GetScanLogHttp,
      ),
    ),
  ),
) {}
