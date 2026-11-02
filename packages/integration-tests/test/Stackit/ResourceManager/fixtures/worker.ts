import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The folder the bindings read. Top-level, so `parentId` is the organization. */
export const Team = Stackit.ResourceManager.Folder("RmBindingsFolder", {
  labels: { purpose: "bindings-test" },
});

/**
 * The project the bindings read. STACKIT requires a user among a new project's members,
 * and the test profile authenticates as a service account, so the suite is gated on this
 * variable. The prop only matters at deploy; the running Worker never reads it.
 */
export const Child = Effect.gen(function* () {
  const team = yield* Team;
  return yield* Stackit.ResourceManager.Project("RmBindingsChildProject", {
    parentId: team.containerId,
    owner: process.env.STACKIT_TEST_PROJECT_OWNER,
  });
});

/**
 * A Cloudflare Worker using the Resource Manager bindings. STACKIT has no native
 * host yet, so the bindings grant on the service account Alchemy creates for the
 * Worker. One route per binding; each answers `{ ok, result | error }` so a
 * failure surfaces the STACKIT error in the test.
 */
export default class RmBindingsWorker extends Cloudflare.Worker<RmBindingsWorker>()(
  "StackitRmBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const team = yield* Team;
    const getFolder = yield* Stackit.ResourceManager.GetFolderDetails(team);
    const getProject = yield* Stackit.ResourceManager.GetProject(yield* Child);
    const listFolders = yield* Stackit.ResourceManager.ListFolders(team);
    const listProjects = yield* Stackit.ResourceManager.ListProjects(team);
    const listOrganizationFolders = yield* Stackit.ResourceManager.ListFolders(team.parentId);
    const getOrganization = yield* Stackit.ResourceManager.GetOrganization(team.parentId);
    const listOrganizations = yield* Stackit.ResourceManager.ListOrganizations(team.parentId);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/folder":
            return yield* respond(getFolder());
          case "/folders":
            return yield* respond(listFolders());
          case "/project":
            return yield* respond(getProject({}));
          case "/projects":
            return yield* respond(listProjects());
          case "/organization-folders":
            return yield* respond(listOrganizationFolders());
          case "/organization":
            return yield* respond(getOrganization());
          case "/organizations":
            return yield* respond(listOrganizations());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ResourceManager.GetFolderDetailsHttp,
        Stackit.ResourceManager.GetProjectHttp,
        Stackit.ResourceManager.ListFoldersHttp,
        Stackit.ResourceManager.ListProjectsHttp,
        Stackit.ResourceManager.GetOrganizationHttp,
        Stackit.ResourceManager.ListOrganizationsHttp,
      ),
    ),
  ),
) {}
