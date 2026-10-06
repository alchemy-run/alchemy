import { adopt } from "@/AdoptPolicy.ts";
import * as GitHub from "@/GitHub/index.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Interaction from "@/Interaction.ts";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Alchemy.ts";
import { isUserFacing } from "@/UserFacingError.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  acceptPermissionsInUi,
  appName,
  appExists,
  appOctokit,
  autopilot,
  deleteAppIfExists,
  ensureFixtureRepos,
  failureOf,
  fixtureRepos,
  installationOctokit,
  owner,
  setAppPermission,
  suspendInstallationInUi,
  withManualStepTimeout,
} from "./app-harness.ts";

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

// Needs the logged-in test browser profile (see app-harness.ts); runs only
// when selected explicitly with `--tags browser`.
// Browser tests share one Chromium profile, so none of them run concurrently.
const browserTest = {
  tags: [
    "provider:github",
    "provider:github:app",
    "provider:github:appinstallation",
    "live",
    "browser",
  ],
  optInTags: ["browser"],
  exclusive: true,
  timeout: 300_000,
};

const [repoA, repoB] = fixtureRepos;

const program = (
  id: string,
  options: {
    readonly permissions?: GitHub.AppProps["permissions"];
    readonly installation?: Omit<
      GitHub.AppInstallationProps,
      "appId" | "privateKey"
    >;
    /** Take over an installation that has no state (`--adopt`). */
    readonly adopt?: boolean;
    /** Uninstall when the resource is removed; the default retains. */
    readonly destroy?: boolean;
  },
) =>
  Effect.gen(function* () {
    const app = yield* GitHub.App("App", {
      owner,
      name: appName(id),
      url: "https://alchemy.run",
      permissions: options.permissions ?? { issues: "read" },
    }).pipe(RemovalPolicy.destroy());
    const installation =
      options.installation === undefined
        ? undefined
        : yield* GitHub.AppInstallation("Installation", {
            appId: app.appId,
            privateKey: app.privateKey,
            ...options.installation,
          }).pipe(
            adopt(options.adopt ?? false),
            RemovalPolicy.destroy(options.destroy ?? false),
          );
    return { app, installation };
  });

const selected = (...repositories: string[]) => ({
  account: owner,
  repositorySelection: "selected" as const,
  repositories,
});

const installedRepos = (
  appId: number,
  privateKey: Redacted.Redacted<string>,
  installationId: number,
) =>
  Effect.gen(function* () {
    const octokit = yield* installationOctokit(
      appId,
      privateKey,
      installationId,
    );
    const repos = yield* Effect.tryPromise(() =>
      octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
        per_page: 100,
      }),
    );
    return repos.map((repo) => repo.name).sort();
  });

const liveInstallation = (
  appId: number,
  privateKey: Redacted.Redacted<string>,
  installationId: number,
) =>
  Effect.tryPromise(() =>
    appOctokit(appId, privateKey).rest.apps.getInstallation({
      installation_id: installationId,
    }),
  ).pipe(Effect.map(({ data }) => data));

const cleanup = (stack: Test.ScratchStack, slug: string) =>
  Effect.gen(function* () {
    yield* autopilot().run(stack.destroy()).pipe(Effect.ignore);
    yield* deleteAppIfExists(yield* Octokit, slug);
  });

describe(
  "GitHub AppInstallation helpers",
  {
    tags: [
      "unit",
      "provider:github",
      "provider:github:appinstallation",
      "local",
    ],
  },
  () => {
    it("builds install, settings and permission-review URLs", () => {
      expect(GitHub.appInstallUrl({ slug: "my-app" })).toBe(
        "https://github.com/apps/my-app/installations/new",
      );
      expect(
        GitHub.installationSettingsUrl({
          account: "FD-Test-Org",
          accountType: "Organization",
          installationId: 123,
        }),
      ).toBe(
        "https://github.com/organizations/FD-Test-Org/settings/installations/123",
      );
      expect(
        GitHub.installationSettingsUrl({
          account: "pattobrien",
          accountType: "User",
          installationId: 123,
        }),
      ).toBe("https://github.com/settings/installations/123");
      expect(
        GitHub.installationPermissionsReviewUrl({
          account: "FD-Test-Org",
          accountType: "Organization",
          installationId: 123,
        }),
      ).toBe(
        "https://github.com/organizations/FD-Test-Org/settings/installations/123/permissions/update",
      );
    });

    it("flags only raised or added permissions as pending", () => {
      expect(
        GitHub.installationPermissionsPending(
          { issues: "write", metadata: "read" },
          { issues: "read", metadata: "read" },
        ),
      ).toEqual(["issues"]);
      expect(
        GitHub.installationPermissionsPending(
          { issues: "read", contents: "read" },
          { issues: "read" },
        ),
      ).toEqual(["contents"]);
      expect(
        GitHub.installationPermissionsPending(
          { administration: "admin" },
          { administration: "write" },
        ),
      ).toEqual(["administration"]);
      expect(
        GitHub.installationPermissionsPending(
          { issues: "read" },
          { issues: "write", pull_requests: "read" },
        ),
      ).toEqual([]);
    });

    it("computes the selected-repository delta", () => {
      expect(
        GitHub.installationRepositoryDelta(["b", "c"], ["a", "b"]),
      ).toEqual({ add: ["c"], remove: ["a"] });
      expect(GitHub.installationRepositoryDelta(["a"], ["a"])).toEqual({
        add: [],
        remove: [],
      });
    });

    it("reports unapplied suspensions and vanished installations to the user", () => {
      const url =
        "https://github.com/organizations/FD-Test-Org/settings/installations/123";
      const notApplied = new GitHub.GitHubAppInstallationSuspensionNotApplied({
        desired: false,
        slug: "my-app",
        account: "FD-Test-Org",
        url,
      });
      expect(isUserFacing(notApplied)).toBe(true);
      expect(notApplied.message).toContain("unsuspend GitHub App my-app");
      expect(notApplied.message).toContain(url);
      expect(
        new GitHub.GitHubAppInstallationSuspensionNotApplied({
          desired: true,
          slug: "my-app",
          account: "FD-Test-Org",
          url,
        }).message,
      ).toContain("did not suspend");
      const missing = new GitHub.GitHubAppInstallationNotFound({
        installationId: 123,
        slug: "my-app",
        account: "FD-Test-Org",
      });
      expect(isUserFacing(missing)).toBe(true);
      expect(missing.message).toContain("installation 123 on FD-Test-Org");
    });

    it("lifts an API suspension through the API and a UI one in the browser", () => {
      const at = "2026-10-06T00:00:00Z";
      const action = GitHub.installationSuspensionAction;
      const slug = "my-app";
      expect(
        action({
          suspendedAt: undefined,
          suspendedBy: undefined,
          slug,
          desired: false,
        }),
      ).toBe("none");
      expect(
        action({
          suspendedAt: at,
          suspendedBy: "my-app[bot]",
          slug,
          desired: true,
        }),
      ).toBe("none");
      expect(
        action({
          suspendedAt: at,
          suspendedBy: "pattobrien",
          slug,
          desired: true,
        }),
      ).toBe("none");
      expect(
        action({
          suspendedAt: undefined,
          suspendedBy: undefined,
          slug,
          desired: true,
        }),
      ).toBe("suspend");
      expect(
        action({
          suspendedAt: at,
          suspendedBy: "My-App[bot]",
          slug,
          desired: false,
        }),
      ).toBe("unsuspend");
      expect(
        action({
          suspendedAt: at,
          suspendedBy: "pattobrien",
          slug,
          desired: false,
        }),
      ).toBe("unsuspend-in-browser");
      expect(
        action({
          suspendedAt: at,
          suspendedBy: "other-app[bot]",
          slug,
          desired: false,
        }),
      ).toBe("unsuspend-in-browser");
      expect(
        action({
          suspendedAt: at,
          suspendedBy: undefined,
          slug,
          desired: false,
        }),
      ).toBe("unsuspend-in-browser");
    });
  },
);

test.provider(
  "installs through the browser, syncs selected repositories, reports a selection switch without a browser, and uninstalls",
  (stack) =>
    Effect.gen(function* () {
      const id = "install";
      yield* cleanup(stack, appName(id));

      const { app } = yield* autopilot()
        .run(stack.deploy(program(id, {})))
        .pipe(withManualStepTimeout("2 minutes"));
      yield* ensureFixtureRepos(yield* Octokit);
      const installUrl = `https://github.com/apps/${app.slug}/installations/new`;

      const noTerminal = failureOf(
        yield* Effect.exit(
          stack.deploy(program(id, { installation: selected(repoA) })),
        ),
      );
      expect(noTerminal).toMatchObject({
        _tag: "GitHubManualStepRequired",
        step: "install-app",
        url: expect.stringContaining(installUrl),
        message: expect.stringContaining(installUrl),
      });
      expect(isUserFacing(noTerminal)).toBe(true);

      const pilot = autopilot();
      const { installation } = yield* pilot
        .run(stack.deploy(program(id, { installation: selected(repoA) })))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(pilot.launched).toContain(installUrl);
      expect(pilot.prompts).toEqual([]);
      expect(installation!.installationId).toBeGreaterThan(0);
      expect(installation!.account).toBe(owner);
      expect(installation!.repositorySelection).toBe("selected");
      expect(installation!.repositories).toEqual([repoA]);
      expect(installation!.permissions).toMatchObject({ issues: "read" });
      expect(installation!.htmlUrl).toBe(
        `https://github.com/organizations/${owner}/settings/installations/${installation!.installationId}`,
      );
      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getInstallation({
          installation_id: installation!.installationId,
        }),
      );
      expect(live.repository_selection).toBe("selected");
      expect(
        yield* installedRepos(
          app.appId,
          app.privateKey,
          installation!.installationId,
        ),
      ).toEqual([repoA]);

      const quiet = autopilot();
      const again = yield* quiet.run(
        stack.deploy(program(id, { installation: selected(repoA) })),
      );
      expect(again.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(quiet.launched).toEqual([]);
      expect(quiet.prompts).toEqual([]);

      // Add, then remove, a selected repository through the API.
      const added = yield* quiet.run(
        stack.deploy(program(id, { installation: selected(repoA, repoB) })),
      );
      expect(added.installation!.repositories).toEqual([repoA, repoB]);
      expect(
        yield* installedRepos(
          app.appId,
          app.privateKey,
          installation!.installationId,
        ),
      ).toEqual([repoA, repoB]);

      const removed = yield* quiet.run(
        stack.deploy(program(id, { installation: selected(repoB) })),
      );
      expect(removed.installation!.repositories).toEqual([repoB]);
      expect(
        yield* installedRepos(
          app.appId,
          app.privateKey,
          installation!.installationId,
        ),
      ).toEqual([repoB]);
      expect(quiet.launched).toEqual([]);

      // selected → all has no API; without a browser it is reported.
      const idle = autopilot({ idle: true });
      const switched = failureOf(
        yield* Effect.exit(
          idle.run(
            stack.deploy(
              program(id, {
                installation: { account: owner, repositorySelection: "all" },
              }),
            ),
          ),
        ),
      );
      const settingsUrl = `https://github.com/organizations/${owner}/settings/installations/${installation!.installationId}`;
      expect(switched).toMatchObject({
        _tag: "GitHubAppInstallationDrift",
        reason: "repository-selection",
        url: settingsUrl,
        message: expect.stringContaining(settingsUrl),
      });
      expect(isUserFacing(switched)).toBe(true);
      expect(idle.launched).toEqual([]);
      expect(idle.prompts).toEqual([]);

      // Default retain: removing the resource drops its state and keeps the
      // installation.
      yield* quiet.run(stack.deploy(program(id, {})));
      const { data: kept } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getInstallation({
          installation_id: installation!.installationId,
        }),
      );
      expect(kept.id).toBe(installation!.installationId);

      // Found on the account with no state, it is someone else's until
      // --adopt takes it over.
      const foreign = failureOf(
        yield* Effect.exit(
          quiet.run(
            stack.deploy(program(id, { installation: selected(repoB) })),
          ),
        ),
      );
      expect(foreign).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      const adopted = yield* quiet.run(
        stack.deploy(
          program(id, { installation: selected(repoB), adopt: true }),
        ),
      );
      expect(adopted.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(quiet.launched).toEqual([]);

      // Opted into destroy(): removing the resource uninstalls through the API.
      yield* quiet.run(
        stack.deploy(
          program(id, { installation: selected(repoB), destroy: true }),
        ),
      );
      yield* quiet.run(stack.deploy(program(id, {})));
      const gone = yield* Effect.exit(
        Effect.tryPromise(() =>
          appOctokit(app.appId, app.privateKey).rest.apps.getOrgInstallation({
            org: owner,
          }),
        ),
      );
      expect(gone._tag).toBe("Failure");
      expect(quiet.launched).toEqual([]);
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("install")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "pending permission approval without a browser fails with the review URL and passes after acceptance",
  (stack) =>
    Effect.gen(function* () {
      const id = "perms";
      yield* cleanup(stack, appName(id));

      yield* autopilot()
        .run(stack.deploy(program(id, {})))
        .pipe(withManualStepTimeout("2 minutes"));
      yield* ensureFixtureRepos(yield* Octokit);
      const { app, installation } = yield* autopilot()
        .run(stack.deploy(program(id, { installation: selected(repoA) })))
        .pipe(withManualStepTimeout("2 minutes"));

      // The human raises the permission in the UI after the App resource
      // reports the drift (covered in App.test.ts).
      yield* setAppPermission({
        slug: app.slug,
        permission: "issues",
        access: "write",
      });

      const raised = {
        permissions: { issues: "write" as const },
        installation: selected(repoA),
      };
      const pending = failureOf(
        yield* Effect.exit(
          autopilot({ idle: true }).run(stack.deploy(program(id, raised))),
        ),
      );
      const reviewUrl = `https://github.com/organizations/${owner}/settings/installations/${installation!.installationId}/permissions/update`;
      expect(pending).toMatchObject({
        _tag: "GitHubAppInstallationDrift",
        reason: "permissions-pending",
        url: reviewUrl,
        message: expect.stringContaining(reviewUrl),
      });
      expect(isUserFacing(pending)).toBe(true);

      yield* acceptPermissionsInUi(reviewUrl);

      const accepted = yield* autopilot().run(
        stack.deploy(program(id, raised)),
      );
      expect(accepted.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(accepted.installation!.permissions).toMatchObject({
        issues: "write",
      });
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("perms")).pipe(Effect.ignore)),
    ),
  browserTest,
);

const unattended = { ...browserTest, timeout: 240_000 };

const nonInteractive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Interaction.layerNonInteractive()),
    withManualStepTimeout("2 minutes"),
  );

test.provider(
  "installs unattended",
  (stack) =>
    Effect.gen(function* () {
      const id = "unattended";
      yield* cleanup(stack, appName(id));
      yield* ensureFixtureRepos(yield* Octokit);

      const pilot = autopilot();
      const { app, installation } = yield* nonInteractive(
        pilot.run(
          stack.deploy(
            program(id, { installation: selected(repoA), destroy: true }),
          ),
        ),
      );
      expect(pilot.prompts).toEqual([]);
      expect(pilot.launched).toContain(
        `https://github.com/apps/${app.slug}/installations/new`,
      );
      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getInstallation({
          installation_id: installation!.installationId,
        }),
      );
      expect(live.id).toBe(installation!.installationId);
      expect(live.repository_selection).toBe("selected");

      yield* nonInteractive(pilot.run(stack.destroy()));
      expect(pilot.prompts).toEqual([]);
      expect(yield* appExists(yield* Octokit, app.slug)).toBe(false);
    }).pipe(
      Effect.ensuring(
        cleanup(stack, appName("unattended")).pipe(Effect.ignore),
      ),
    ),
  unattended,
);

test.provider(
  "switches selected→all unattended",
  (stack) =>
    Effect.gen(function* () {
      const id = "switch";
      yield* cleanup(stack, appName(id));
      yield* ensureFixtureRepos(yield* Octokit);

      const { app, installation } = yield* autopilot()
        .run(stack.deploy(program(id, { installation: selected(repoA) })))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(installation!.repositorySelection).toBe("selected");

      const pilot = autopilot();
      const switched = yield* pilot
        .run(
          stack.deploy(
            program(id, {
              installation: { account: owner, repositorySelection: "all" },
            }),
          ),
        )
        .pipe(withManualStepTimeout("2 minutes"));
      expect(switched.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(switched.installation!.repositorySelection).toBe("all");
      expect(switched.installation!.repositories).toEqual([]);
      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getInstallation({
          installation_id: installation!.installationId,
        }),
      );
      expect(live.repository_selection).toBe("all");
      expect(pilot.launched).toContain(
        `https://github.com/organizations/${owner}/settings/installations/${installation!.installationId}`,
      );
      expect(pilot.prompts).toEqual([]);
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("switch")).pipe(Effect.ignore)),
    ),
  unattended,
);

test.provider(
  "accepts pending permissions unattended",
  (stack) =>
    Effect.gen(function* () {
      const id = "perms-auto";
      yield* cleanup(stack, appName(id));
      yield* ensureFixtureRepos(yield* Octokit);

      const { app, installation } = yield* autopilot()
        .run(stack.deploy(program(id, { installation: selected(repoA) })))
        .pipe(withManualStepTimeout("2 minutes"));

      yield* setAppPermission({
        slug: app.slug,
        permission: "issues",
        access: "write",
      });

      const pilot = autopilot();
      const accepted = yield* pilot
        .run(
          stack.deploy(
            program(id, {
              permissions: { issues: "write" },
              installation: selected(repoA),
            }),
          ),
        )
        .pipe(withManualStepTimeout("2 minutes"));
      expect(accepted.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(accepted.installation!.permissions).toMatchObject({
        issues: "write",
      });
      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getInstallation({
          installation_id: installation!.installationId,
        }),
      );
      expect(
        GitHub.installationPermissionsPending(
          { issues: "write" },
          Object.fromEntries(Object.entries(live.permissions)),
        ),
      ).toEqual([]);
      expect(pilot.launched).toContain(
        `https://github.com/organizations/${owner}/settings/installations/${installation!.installationId}/permissions/update`,
      );
      expect(pilot.prompts).toEqual([]);
    }).pipe(
      Effect.ensuring(
        cleanup(stack, appName("perms-auto")).pipe(Effect.ignore),
      ),
    ),
  unattended,
);

test.provider(
  "suspends and unsuspends through the API",
  (stack) =>
    Effect.gen(function* () {
      const id = "suspend";
      yield* cleanup(stack, appName(id));
      yield* ensureFixtureRepos(yield* Octokit);

      const { app, installation } = yield* autopilot()
        .run(
          stack.deploy(
            program(id, {
              installation: { ...selected(repoA), suspended: true },
            }),
          ),
        )
        .pipe(withManualStepTimeout("2 minutes"));
      expect(installation!.suspended).toBe(true);
      expect(installation!.suspendedAt).toEqual(expect.any(String));
      expect(installation!.suspendedBy).toBe(`${app.slug}[bot]`);
      const suspended = yield* liveInstallation(
        app.appId,
        app.privateKey,
        installation!.installationId,
      );
      expect(suspended.suspended_at).not.toBeNull();
      expect(suspended.suspended_by?.login).toMatch(/\[bot\]$/);

      const quiet = autopilot();
      const lifted = yield* quiet.run(
        stack.deploy(
          program(id, {
            installation: { ...selected(repoA, repoB), suspended: false },
          }),
        ),
      );
      expect(lifted.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(lifted.installation!.suspended).toBe(false);
      expect(lifted.installation!.suspendedAt).toBeUndefined();
      expect(lifted.installation!.suspendedBy).toBeUndefined();
      expect(lifted.installation!.repositories).toEqual([repoA, repoB]);
      const live = yield* liveInstallation(
        app.appId,
        app.privateKey,
        installation!.installationId,
      );
      expect(live.suspended_at).toBeNull();
      expect(
        yield* installedRepos(
          app.appId,
          app.privateKey,
          installation!.installationId,
        ),
      ).toEqual([repoA, repoB]);
      expect(quiet.launched).toEqual([]);
      expect(quiet.prompts).toEqual([]);
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("suspend")).pipe(Effect.ignore)),
    ),
  unattended,
);

test.provider(
  "lifts a UI suspension through the browser and reports it without one",
  (stack) =>
    Effect.gen(function* () {
      const id = "suspend-ui";
      yield* cleanup(stack, appName(id));
      yield* ensureFixtureRepos(yield* Octokit);

      const { app, installation } = yield* autopilot()
        .run(stack.deploy(program(id, { installation: selected(repoA) })))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(installation!.suspended).toBe(false);
      const settingsUrl = `https://github.com/organizations/${owner}/settings/installations/${installation!.installationId}`;

      yield* suspendInstallationInUi(settingsUrl);
      const suspended = yield* liveInstallation(
        app.appId,
        app.privateKey,
        installation!.installationId,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (live) => live.suspended_at !== null,
          times: 10,
        }),
      );
      expect(suspended.suspended_at).not.toBeNull();
      expect(suspended.suspended_by?.login).not.toMatch(/\[bot\]$/);

      const unsuspend = {
        installation: { ...selected(repoA), suspended: false },
      };
      const idle = autopilot({ idle: true });
      const reported = failureOf(
        yield* Effect.exit(idle.run(stack.deploy(program(id, unsuspend)))),
      );
      expect(reported).toMatchObject({
        _tag: "GitHubAppInstallationDrift",
        reason: "suspended",
        url: settingsUrl,
        message: expect.stringContaining(settingsUrl),
      });
      expect(isUserFacing(reported)).toBe(true);
      expect(idle.launched).toEqual([]);
      expect(idle.prompts).toEqual([]);

      const pilot = autopilot();
      const lifted = yield* pilot
        .run(stack.deploy(program(id, unsuspend)))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(lifted.installation!.installationId).toBe(
        installation!.installationId,
      );
      expect(lifted.installation!.suspended).toBe(false);
      expect(lifted.installation!.suspendedAt).toBeUndefined();
      expect(pilot.launched).toContain(settingsUrl);
      expect(pilot.prompts).toEqual([]);
      const live = yield* liveInstallation(
        app.appId,
        app.privateKey,
        installation!.installationId,
      );
      expect(live.suspended_at).toBeNull();

      yield* pilot
        .run(stack.destroy())
        .pipe(withManualStepTimeout("2 minutes"));
      expect(yield* appExists(yield* Octokit, app.slug)).toBe(false);
    }).pipe(
      Effect.ensuring(
        cleanup(stack, appName("suspend-ui")).pipe(Effect.ignore),
      ),
    ),
  unattended,
);
