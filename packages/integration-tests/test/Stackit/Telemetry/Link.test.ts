import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// One link per project and region: everything in this file takes the same lock. The link
// is free, and routers bill traffic only, so the project lifecycle runs ungated. Holding a
// link across tests can't be expressed with a lock, so `LinkBindings.test.ts` only runs
// under its own flag, and that flag turns off what here shares its links.
const options = {
  tags: stackitTags("telemetry", "link"),
  timeout: 900_000,
  exclusive: "stackit:telemetry-link:project",
} as const;

/** Folder and organization links need elevated rights in the test account. */
const noOrgRoles = !process.env.STACKIT_TEST_ORG_ROLES;

/** `LinkBindings.test.ts` holds the project's and the organization's link for its whole run. */
const bindingsHoldLinks = !!process.env.STACKIT_TEST_LINK_BINDINGS;

const observeProjectLink = (projectId: string, region: string) =>
  telemetry
    .getProjectTelemetryLink({ projectId, regionId: region })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

/** Bounded wait (about 2 minutes) until a read reports `"gone"`, then assert it. */
const expectGone = <A, E, R>(read: Effect.Effect<A | "gone", E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (value) => value === "gone",
      times: 24,
    }),
    Effect.tap((value) => Effect.sync(() => expect(value).toEqual("gone"))),
  );

const routing = (routerId: "First" | "Second") =>
  Effect.gen(function* () {
    const first = yield* Stackit.Telemetry.Router("LinkRouterFirst", {});
    const second = yield* Stackit.Telemetry.Router("LinkRouterSecond", {});
    const router = routerId === "First" ? first : second;
    const token = yield* Stackit.Telemetry.AccessToken(`LinkToken${routerId}`, {
      routerId: router.routerId,
    });
    return { first, second, router, token };
  });

const app = (
  routerId: "First" | "Second",
  props: Omit<Stackit.Telemetry.LinkProps, "routerId" | "accessToken">,
) =>
  Effect.gen(function* () {
    const { first, second, router, token } = yield* routing(routerId);
    const link = yield* Stackit.Telemetry.Link("ProjectLink", {
      routerId: router.routerId,
      accessToken: token.accessToken,
      ...props,
    });
    return { first, second, link };
  });

test.provider.skipIf(bindingsHoldLinks)(
  "create, update and delete a project's link",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* expectGone(observeProjectLink(projectId, region));

      const props = { description: "alchemy test link", labels: { env: "test" } };
      const { first, second, link } = yield* stack.deploy(app("First", props));
      expect(link.linkId).toEqual(expect.any(String));
      expect(link.scopeType).toEqual("project");
      expect(link.scopeId).toEqual(projectId);
      expect(link.region).toEqual(region);
      expect(link.routerId).toEqual(first.routerId);
      expect(link.enabled).toBe(true);
      expect(link.status).toEqual("active");
      expect(link.labels).toEqual({ env: "test" });
      expect(link.displayName.length).toBeLessThanOrEqual(32);

      // Out of band: the link exists, with Alchemy's ownership labels.
      const fetched = yield* telemetry.getProjectTelemetryLink({ projectId, regionId: region });
      expect(fetched.id).toEqual(link.linkId);
      expect(fetched.telemetryRouterId).toEqual(first.routerId);
      expect(fetched.resourceLabels).toMatchObject({ env: "test", "alchemy.id": "ProjectLink" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app("First", props));
      expect(plan.resources.ProjectLink).toMatchObject({ action: "noop" });

      // Router, token, name, description and labels update in place. A label removed goes.
      const { link: moved } = yield* stack.deploy(
        app("Second", {
          displayName: "alchemy-link-updated",
          description: "alchemy test link updated",
          labels: { team: "security" },
        }),
      );
      expect(moved.linkId).toEqual(link.linkId);
      expect(moved.routerId).toEqual(second.routerId);
      expect(moved.displayName).toEqual("alchemy-link-updated");
      expect(moved.labels).toEqual({ team: "security" });

      const refetched = yield* telemetry.getProjectTelemetryLink({ projectId, regionId: region });
      expect(refetched.telemetryRouterId).toEqual(second.routerId);
      expect(refetched.displayName).toEqual("alchemy-link-updated");
      expect(refetched.description).toEqual("alchemy test link updated");
      expect(refetched.resourceLabels?.env).toBeUndefined();
      expect(refetched.resourceLabels).toMatchObject({ team: "security" });

      // A link can be paused without losing anything else.
      const { link: paused } = yield* stack.deploy(
        app("Second", { displayName: "alchemy-link-updated", enabled: false }),
      );
      expect(paused.linkId).toEqual(link.linkId);
      expect(paused.enabled).toBe(false);
      const pausedLive = yield* telemetry.getProjectTelemetryLink({ projectId, regionId: region });
      expect(pausedLive.enabled).toBe(false);
      expect(pausedLive.description).toEqual("alchemy test link updated");

      yield* stack.destroy();
      yield* expectGone(observeProjectLink(projectId, region));
    }).pipe(logLevel),
  options,
);

/** Delete a link made out of band whatever the assertions do: nuke can't find it. */
const removeProjectLink = (projectId: string, region: string) =>
  telemetry
    .deleteProjectTelemetryLink({ projectId, regionId: region })
    .pipe(Effect.andThen(expectGone(observeProjectLink(projectId, region))), Effect.ignore);

test.provider.skipIf(bindingsHoldLinks)(
  "a link that isn't Alchemy's is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* expectGone(observeProjectLink(projectId, region));

      const { router, token } = yield* stack.deploy(routing("First"));
      yield* Effect.acquireUseRelease(
        telemetry.createOrUpdateProjectTelemetryLink({
          projectId,
          regionId: region,
          ifNoneMatch: "*",
          displayName: "alchemy-link-foreign",
          telemetryRouterId: router.routerId,
          accessToken: token.accessToken!,
        }),
        (created) =>
          Effect.gen(function* () {
            // A second create is refused by the precondition, not overwritten.
            const refused = yield* telemetry
              .createOrUpdateProjectTelemetryLink({
                projectId,
                regionId: region,
                ifNoneMatch: "*",
                displayName: "alchemy-link-other",
                telemetryRouterId: router.routerId,
                accessToken: token.accessToken!,
              })
              .pipe(Effect.flip);
            expect(refused._tag).toEqual("PreconditionFailed");

            const error = yield* stack.deploy(app("First", {})).pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");

            const fetched = yield* telemetry.getProjectTelemetryLink({
              projectId,
              regionId: region,
            });
            expect(fetched.id).toEqual(created.id);
            expect(fetched.displayName).toEqual("alchemy-link-foreign");
          }),
        () => removeProjectLink(projectId, region),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(bindingsHoldLinks)(
  "a link that took over the scope is neither updated nor deleted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* expectGone(observeProjectLink(projectId, region));

      const { router, token } = yield* stack.deploy(routing("First"));
      const { link } = yield* stack.deploy(app("First", {}));

      // Ours goes out of band, and someone else takes the scope.
      yield* telemetry.deleteProjectTelemetryLink({ projectId, regionId: region });
      yield* expectGone(observeProjectLink(projectId, region));

      yield* Effect.acquireUseRelease(
        telemetry.createOrUpdateProjectTelemetryLink({
          projectId,
          regionId: region,
          ifNoneMatch: "*",
          displayName: "alchemy-link-foreign",
          description: "theirs",
          telemetryRouterId: router.routerId,
          accessToken: token.accessToken!,
        }),
        (created) =>
          Effect.gen(function* () {
            expect(created.id).not.toEqual(link.linkId);

            // A change of props reaches reconcile, which must not patch their link.
            const error = yield* stack
              .deploy(app("First", { description: "ours" }))
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");
            const untouched = yield* telemetry.getProjectTelemetryLink({
              projectId,
              regionId: region,
            });
            expect(untouched.id).toEqual(created.id);
            expect(untouched.description).toEqual("theirs");

            // Taking the link out of the stack deletes nothing, and the routers stay for
            // their link.
            yield* stack.deploy(routing("First"));
            const survivor = yield* telemetry.getProjectTelemetryLink({
              projectId,
              regionId: region,
            });
            expect(survivor.id).toEqual(created.id);
          }),
        () => removeProjectLink(projectId, region),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(noOrgRoles || bindingsHoldLinks)(
  "a folder's link, and moving a link between scopes",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      yield* expectGone(observeProjectLink(projectId, region));

      const onFolder = (folderScope: boolean) =>
        Effect.gen(function* () {
          const folder = yield* Stackit.ResourceManager.Folder("LinkFolder", {});
          const { router, token } = yield* routing("First");
          const link = yield* Stackit.Telemetry.Link("MovedLink", {
            ...(folderScope ? { scope: { folderId: folder.folderId } } : {}),
            routerId: router.routerId,
            accessToken: token.accessToken,
          });
          return { folder, link };
        });

      const { folder, link } = yield* stack.deploy(onFolder(true));
      expect(link.scopeType).toEqual("folder");
      expect(link.scopeId).toEqual(folder.folderId);
      const fetched = yield* telemetry.getFolderTelemetryLink({
        folderId: folder.folderId,
        regionId: region,
      });
      expect(fetched.id).toEqual(link.linkId);

      // A different scope is a different singleton: the old link goes.
      const { link: moved } = yield* stack.deploy(onFolder(false));
      expect(moved.scopeType).toEqual("project");
      expect(moved.linkId).not.toEqual(link.linkId);
      yield* expectGone(
        telemetry
          .getFolderTelemetryLink({ folderId: folder.folderId, regionId: region })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const))),
      );

      yield* stack.destroy();
      yield* expectGone(observeProjectLink(projectId, region));
    }).pipe(logLevel),
  { ...options, exclusive: "stackit:telemetry-link:project" },
);

test.provider.skipIf(noOrgRoles || bindingsHoldLinks)(
  "an organization's link",
  (stack) =>
    Effect.gen(function* () {
      const { organizationId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { link } = yield* stack.deploy(
        Effect.gen(function* () {
          const { router, token } = yield* routing("First");
          const link = yield* Stackit.Telemetry.Link("OrganizationLink", {
            scope: { organizationId: organizationId! },
            routerId: router.routerId,
            accessToken: token.accessToken,
          });
          return { link };
        }),
      );
      expect(link.scopeType).toEqual("organization");
      expect(link.scopeId).toEqual(organizationId);
      const fetched = yield* telemetry.getOrganizationTelemetryLink({
        organizationId: organizationId!,
        regionId: region,
      });
      expect(fetched.id).toEqual(link.linkId);

      yield* stack.destroy();
      yield* expectGone(
        telemetry
          .getOrganizationTelemetryLink({ organizationId: organizationId!, regionId: region })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const))),
      );
    }).pipe(logLevel),
  { ...options, exclusive: "stackit:telemetry-link:organization" },
);
