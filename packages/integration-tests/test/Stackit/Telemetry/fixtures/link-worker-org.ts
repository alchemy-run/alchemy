import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Folder = Stackit.ResourceManager.Folder("LinkBindingsFolder", {});

const routing = Effect.gen(function* () {
  const router = yield* Stackit.Telemetry.Router("LinkBindingsOrgRouter", {});
  const token = yield* Stackit.Telemetry.AccessToken("LinkBindingsOrgToken", {
    routerId: router.routerId,
  });
  return { router, token };
});

export const FolderAudit = Effect.gen(function* () {
  const folder = yield* Folder;
  const { router, token } = yield* routing;
  return yield* Stackit.Telemetry.Link("LinkBindingsFolderLink", {
    scope: { folderId: folder.folderId },
    routerId: router.routerId,
    accessToken: token.accessToken,
  });
});

/** The profile's organization, resolved at plan, as `Link.test.ts` addresses it. */
const organizationId = Output.fromEffect(
  Stackit.StackitEnvironment.current.pipe(
    Effect.flatMap(Stackit.requireOrganizationId),
    Effect.orDie,
  ),
);

export const OrganizationAudit = Effect.gen(function* () {
  const { router, token } = yield* routing;
  return yield* Stackit.Telemetry.Link("LinkBindingsOrganizationLink", {
    scope: { organizationId },
    routerId: router.routerId,
    accessToken: token.accessToken,
  });
});

/**
 * A Cloudflare Worker with the bindings on a folder's and an organization's link. One route
 * per binding; each answers `{ ok, result | error }` so a failure surfaces the error in the
 * test. It needs elevated rights in the test account, so its suite is gated.
 */
export default class LinkBindingsOrgWorker extends Cloudflare.Worker<LinkBindingsOrgWorker>()(
  "StackitLinkBindingsOrgWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const folderLink = yield* FolderAudit;
    const organizationLink = yield* OrganizationAudit;
    const getFolderLink = yield* Stackit.Telemetry.GetFolderLink(folderLink);
    const backflushFolder = yield* Stackit.Telemetry.BackflushFolder(folderLink);
    const getFolderJob = yield* Stackit.Telemetry.GetFolderBackflushJob(folderLink);
    const listFolderJobs = yield* Stackit.Telemetry.ListFolderBackflushJobs(folderLink);
    const getOrganizationLink = yield* Stackit.Telemetry.GetOrganizationLink(organizationLink);
    const backflushOrganization = yield* Stackit.Telemetry.BackflushOrganization(organizationLink);
    const getOrganizationJob =
      yield* Stackit.Telemetry.GetOrganizationBackflushJob(organizationLink);
    const listOrganizationJobs =
      yield* Stackit.Telemetry.ListOrganizationBackflushJobs(organizationLink);

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
        const id = url.searchParams.get("id") ?? "";
        switch (url.pathname) {
          case "/folder/get-link":
            return yield* respond(
              getFolderLink({}).pipe(Effect.map((live) => ({ id: live.id, status: live.status }))),
            );
          case "/folder/backflush":
            return yield* respond(backflushFolder({ displayName: "alchemy-replay" }));
          case "/folder/get-job":
            return yield* respond(getFolderJob({ backflushJobId: id }));
          case "/folder/list-jobs":
            return yield* respond(listFolderJobs({ pageSize: 100 }));
          case "/organization/get-link":
            return yield* respond(
              getOrganizationLink({}).pipe(
                Effect.map((live) => ({ id: live.id, status: live.status })),
              ),
            );
          case "/organization/backflush":
            return yield* respond(backflushOrganization({ displayName: "alchemy-replay" }));
          case "/organization/get-job":
            return yield* respond(getOrganizationJob({ backflushJobId: id }));
          case "/organization/list-jobs":
            return yield* respond(listOrganizationJobs({ pageSize: 100 }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Stackit.Telemetry.GetFolderLinkHttp),
    Effect.provide(Stackit.Telemetry.BackflushFolderHttp),
    Effect.provide(Stackit.Telemetry.GetFolderBackflushJobHttp),
    Effect.provide(Stackit.Telemetry.ListFolderBackflushJobsHttp),
    Effect.provide(Stackit.Telemetry.GetOrganizationLinkHttp),
    Effect.provide(Stackit.Telemetry.BackflushOrganizationHttp),
    Effect.provide(Stackit.Telemetry.GetOrganizationBackflushJobHttp),
    Effect.provide(Stackit.Telemetry.ListOrganizationBackflushJobsHttp),
  ),
) {}
