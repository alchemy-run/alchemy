import { adopt } from "@/AdoptPolicy.ts";
import { DestroyError } from "@/Apply.ts";
import * as Drift from "@/Drift.ts";
import * as GitHub from "@/GitHub/index.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Interaction from "@/Interaction.ts";
import * as Output from "@/Output.ts";
import { Random, RandomProvider } from "@/Random.ts";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy.ts";
import { isUserFacing } from "@/UserFacingError.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import {
  appExists,
  appName,
  appOctokit,
  autopilot,
  deleteAppIfExists,
  deleteAppInUi,
  ensureFixtureRepos,
  failureOf,
  fixtureRepos,
  listTestAppsInUi,
  owner,
  setAppPermission,
  withManualStepTimeout,
} from "./app-harness.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    GitHub.providers({ baseUrl: "github.com" }),
    RandomProvider(),
  ),
});

const apiTags = ["provider:github", "provider:github:app", "live"] as const;
// Needs the logged-in test browser profile (see app-harness.ts); runs only
// when selected explicitly with `--tags browser`.
const browserTest = {
  tags: [...apiTags, "browser"],
  optInTags: ["browser"],
  timeout: 300_000,
};

const appProps = (
  id: string,
  overrides: Partial<GitHub.AppProps> = {},
): GitHub.AppProps => ({
  owner,
  name: appName(id),
  url: "https://alchemy.run",
  description: "alchemy GitHub App integration test",
  permissions: { issues: "read" },
  ...overrides,
});

// Apps retain by default; these tests exercise the browser delete step.
const deployApp = (props: GitHub.AppProps) =>
  GitHub.App("App", props).pipe(RemovalPolicy.destroy());

const persistedApp = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    return yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: "App",
    });
  });

// A failed registration leaves at most the engine's `creating` checkpoint,
// which carries no attributes: no app was created.
const expectNoAppPersisted = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const row = yield* persistedApp(stack);
    if (row === undefined) return;
    expect(row.status).toBe("creating");
    expect("attr" in row ? row.attr : undefined).toBeUndefined();
  });

// A destroy without a terminal must drop that checkpoint without asking a
// human or opening a browser.
const expectQuietDestroy = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const launched: string[] = [];
    yield* stack
      .destroy()
      .pipe(
        Effect.provideService(Interaction.BrowserLauncher, (url) =>
          Effect.sync(() => launched.push(url)),
        ),
      );
    expect(launched).toEqual([]);
    expect(yield* persistedApp(stack)).toBeUndefined();
  });

const unattended = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Interaction.layerNonInteractive()));

const identity = (stack: Test.ScratchStack) => ({
  name: stack.name,
  stage: stack.stage,
});

// Delete failures surface as one `DestroyError`; these are its causes.
const destroyFailures = (error: unknown) => {
  expect(error).toBeInstanceOf(DestroyError);
  return error instanceof DestroyError
    ? {
        message: error.message,
        causes: error.failures.map((failure) => Cause.squash(failure.cause)),
      }
    : undefined;
};

// Leading/trailing cleanup for browser tests: deleting an app has no API, so
// the scratch stack is destroyed through the browser, and an app left behind
// by a run that lost its state is deleted by its deterministic name.
const cleanup = (stack: Test.ScratchStack, slug: string) =>
  Effect.gen(function* () {
    yield* autopilot().run(stack.destroy()).pipe(Effect.ignore);
    yield* deleteAppIfExists(yield* Octokit, slug);
  });

describe(
  "GitHub App helpers",
  { tags: ["unit", "provider:github", "provider:github:app", "local"] },
  () => {
    it("builds the registration manifest from props", () => {
      const manifest = GitHub.appManifest(
        appProps("unit", {
          events: ["issues"],
          webhook: {
            url: "https://example.com/hook",
            secret: Redacted.make("s3cret"),
          },
        }),
        { redirectUrl: "http://127.0.0.1:4321/callback" },
      );
      expect(manifest).toEqual({
        name: appName("unit"),
        url: "https://alchemy.run",
        description: "alchemy GitHub App integration test",
        public: false,
        default_permissions: { issues: "read" },
        default_events: ["issues"],
        hook_attributes: { url: "https://example.com/hook" },
        redirect_url: "http://127.0.0.1:4321/callback",
        request_oauth_on_install: false,
      });
      // Manifests cannot carry a webhook secret; it is set via the API.
      expect(JSON.stringify(manifest)).not.toContain("s3cret");
      expect(
        GitHub.appManifest(appProps("unit", { requestOauthOnInstall: true }), {
          redirectUrl: "http://127.0.0.1:4321/callback",
        }).request_oauth_on_install,
      ).toBe(true);
    });

    it("omits hook attributes when no webhook is configured", () => {
      const manifest = GitHub.appManifest(appProps("unit"), {
        redirectUrl: "http://127.0.0.1:4321/callback",
      });
      expect(manifest.hook_attributes).toBeUndefined();
      expect(manifest.public).toBe(false);
    });

    it("derives the slug from the name unless one is given", () => {
      expect(GitHub.appSlug({ name: "My Org Bot" })).toBe("my-org-bot");
      expect(GitHub.appSlug({ name: " shed_build! " })).toBe("shed-build");
      expect(GitHub.appSlug({ name: "Renamed", slug: "shed-build" })).toBe(
        "shed-build",
      );
    });

    it("builds registration and settings URLs for orgs and users", () => {
      expect(
        GitHub.appRegistrationUrl({ owner: "FD-Test-Org", state: "abc" }),
      ).toBe(
        "https://github.com/organizations/FD-Test-Org/settings/apps/new?state=abc",
      );
      expect(GitHub.appRegistrationUrl({ state: "abc" })).toBe(
        "https://github.com/settings/apps/new?state=abc",
      );
      expect(
        GitHub.appRegistrationUrl({
          owner: "acme",
          state: "abc",
          baseUrl: "github.example.com",
        }),
      ).toBe(
        "https://github.example.com/organizations/acme/settings/apps/new?state=abc",
      );
      expect(
        GitHub.appSettingsUrl({ owner: "FD-Test-Org", slug: "my-app" }),
      ).toBe(
        "https://github.com/organizations/FD-Test-Org/settings/apps/my-app",
      );
      expect(
        GitHub.appSettingsUrl({
          owner: "FD-Test-Org",
          slug: "my-app",
          page: "advanced",
        }),
      ).toBe(
        "https://github.com/organizations/FD-Test-Org/settings/apps/my-app/advanced",
      );
      expect(
        GitHub.appSettingsUrl({ slug: "my-app", page: "permissions" }),
      ).toBe("https://github.com/settings/apps/my-app/permissions");
    });

    it("accepts the manifest callback only with the expected state", () => {
      const ok = Effect.runSync(
        Effect.result(
          GitHub.parseManifestCallback(
            "http://127.0.0.1:4321/callback?code=c0de&state=expected",
            "expected",
          ),
        ),
      );
      expect(Result.isSuccess(ok) && ok.success).toBe("c0de");

      const forged = Effect.runSync(
        Effect.result(
          GitHub.parseManifestCallback(
            "http://127.0.0.1:4321/callback?code=c0de&state=forged",
            "expected",
          ),
        ),
      );
      expect(Result.isFailure(forged) && forged.failure).toMatchObject({
        _tag: "GitHubAppManifestStateMismatch",
      });

      const missing = Effect.runSync(
        Effect.result(
          GitHub.parseManifestCallback(
            "http://127.0.0.1:4321/callback?state=expected",
            "expected",
          ),
        ),
      );
      expect(Result.isFailure(missing)).toBe(true);
    });

    it("ignores GitHub's implicit metadata permission, event order and empty descriptions", () => {
      const live = {
        name: appName("unit"),
        description: null,
        external_url: "https://alchemy.run",
        permissions: { issues: "read", metadata: "read" },
        events: ["pull_request", "issues"],
      };
      expect(
        GitHub.appDrift(
          appProps("unit", {
            description: undefined,
            events: ["issues", "pull_request"],
          }),
          live,
        ),
      ).toEqual([]);
    });

    it("reports every unfixable difference with desired and live values", () => {
      const drift = GitHub.appDrift(
        appProps("unit", {
          name: appName("renamed"),
          url: "https://example.com",
          permissions: { issues: "write" },
          events: ["issues", "push"],
        }),
        {
          name: appName("unit"),
          description: "something else",
          external_url: "https://alchemy.run",
          permissions: { issues: "read", metadata: "read" },
          events: ["issues"],
        },
      );
      expect(drift).toEqual(
        expect.arrayContaining([
          {
            field: "name",
            desired: appName("renamed"),
            live: appName("unit"),
          },
          {
            field: "description",
            desired: "alchemy GitHub App integration test",
            live: "something else",
          },
          {
            field: "url",
            desired: "https://example.com",
            live: "https://alchemy.run",
          },
          {
            field: "permissions",
            desired: { issues: "write" },
            live: { issues: "read" },
          },
          { field: "events", desired: ["issues", "push"], live: ["issues"] },
        ]),
      );
      expect(drift).toHaveLength(5);
    });
  },
);

test.provider(
  "registration without a terminal fails loudly with the registration URL",
  (stack) =>
    Effect.gen(function* () {
      const props = appProps("noterm");
      yield* stack.destroy();

      const error = failureOf(
        yield* Effect.exit(stack.deploy(deployApp(props))),
      );
      expect(error).toMatchObject({
        _tag: "GitHubManualStepRequired",
        step: "register-app",
        url: expect.stringContaining(
          `https://github.com/organizations/${owner}/settings/apps/new`,
        ),
        message: expect.stringContaining(
          `GitHub has no API to create GitHub App ${props.name}. Run deploy in an interactive terminal`,
        ),
      });
      expect(isUserFacing(error)).toBe(true);
      expect(yield* appExists(yield* Octokit, props.name)).toBe(false);
      yield* expectNoAppPersisted(stack);
      yield* expectQuietDestroy(stack);
    }),
  { tags: [...apiTags], timeout: 60_000 },
);

test.provider(
  "events without a webhook are rejected before any manual step",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const human = autopilot({ idle: true });
      const error = failureOf(
        yield* Effect.exit(
          human.run(
            stack.deploy(deployApp(appProps("nohook", { events: ["issues"] }))),
          ),
        ),
      );
      expect(error).toMatchObject({ _tag: "GitHubAppEventsRequireWebhook" });
      expect(isUserFacing(error)).toBe(true);
      expect(human.launched).toEqual([]);
      expect(human.prompts).toEqual([]);
      yield* expectQuietDestroy(stack);
    }),
  { tags: [...apiTags], timeout: 60_000 },
);

test.provider(
  "registration times out when nobody completes it",
  (stack) =>
    Effect.gen(function* () {
      const props = appProps("timeout");
      yield* stack.destroy();

      const human = autopilot({ idle: true });
      const error = failureOf(
        yield* Effect.exit(
          human
            .run(stack.deploy(deployApp(props)))
            .pipe(withManualStepTimeout("5 seconds")),
        ),
      );
      expect(error).toMatchObject({
        _tag: "GitHubManualStepTimeout",
        step: "register-app",
      });
      expect(isUserFacing(error)).toBe(true);
      expect(human.launched).toHaveLength(1);
      expect(new URL(human.launched[0]!).hostname).toMatch(
        /^(127\.0\.0\.1|localhost)$/,
      );
      expect(human.prompts).toHaveLength(1);
      expect(yield* appExists(yield* Octokit, props.name)).toBe(false);
      yield* expectNoAppPersisted(stack);
      yield* expectQuietDestroy(stack);
    }),
  { tags: [...apiTags], timeout: 60_000 },
);

test.provider(
  "registers via the manifest flow, redeploys as a no-op, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const props = appProps("lifecycle");
      yield* cleanup(stack, props.name);

      const human = autopilot();
      const app = yield* human
        .run(stack.deploy(deployApp(props)))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(app.appId).toBeGreaterThan(0);
      expect(app.slug).toBe(props.name);
      expect(app.owner).toBe(owner);
      expect(app.clientId).toEqual(expect.any(String));
      expect(app.htmlUrl).toBe(`https://github.com/apps/${props.name}`);
      expect(app.permissions).toMatchObject({ issues: "read" });
      expect(app.events).toEqual([]);
      expect(Redacted.isRedacted(app.clientSecret)).toBe(true);
      expect(Redacted.isRedacted(app.privateKey)).toBe(true);
      expect(human.launched).toHaveLength(1);

      // The returned private key authenticates as the app.
      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getAuthenticated(),
      );
      expect(live?.id).toBe(app.appId);
      expect(live?.slug).toBe(app.slug);

      const detected = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(detected.resources["App"]?.action).toBe("unchanged");

      const quiet = autopilot();
      const again = yield* quiet.run(stack.deploy(deployApp(props)));
      expect(again.appId).toBe(app.appId);
      expect(quiet.launched).toEqual([]);
      expect(quiet.prompts).toEqual([]);

      const remover = autopilot();
      yield* remover
        .run(stack.destroy())
        .pipe(withManualStepTimeout("2 minutes"));
      expect(remover.launched).toEqual([
        `https://github.com/organizations/${owner}/settings/apps/${props.name}/advanced`,
      ]);
      expect(yield* appExists(yield* Octokit, props.name)).toBe(false);
      expect(yield* persistedApp(stack)).toBeUndefined();
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("lifecycle")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "updates the webhook config through the API",
  (stack) =>
    Effect.gen(function* () {
      const id = "webhook";
      yield* cleanup(stack, appName(id));

      const app = yield* autopilot()
        .run(
          stack.deploy(
            deployApp(
              appProps(id, {
                events: ["issues"],
                webhook: { url: "https://example.com/hook-a" },
              }),
            ),
          ),
        )
        .pipe(withManualStepTimeout("2 minutes"));
      expect(app.events).toEqual(["issues"]);

      // The URL is another resource's Output and the secret a shared Random,
      // as a Worker-backed webhook would wire them.
      yield* ensureFixtureRepos(yield* Octokit);
      const human = autopilot();
      const updated = yield* human.run(
        stack.deploy(
          Effect.gen(function* () {
            const secret = yield* Random("WebhookSecret");
            const fixture = yield* GitHub.Repository("Fixture", {
              owner,
              name: fixtureRepos[0],
            });
            const app = yield* GitHub.App("App", {
              ...appProps(id, { events: ["issues"] }),
              webhook: {
                url: Output.interpolate`${fixture.htmlUrl}/hook`,
                contentType: "form",
                secret: secret.text,
              },
            }).pipe(RemovalPolicy.destroy());
            return { app, secret };
          }),
        ),
      );
      expect(updated.app.appId).toBe(app.appId);
      expect(human.launched).toEqual([]);
      expect(human.prompts).toEqual([]);
      expect(Redacted.value(updated.app.webhookSecret!)).toBe(
        Redacted.value(updated.secret.text),
      );

      const { data: config } = yield* Effect.tryPromise(() =>
        appOctokit(
          app.appId,
          app.privateKey,
        ).rest.apps.getWebhookConfigForApp(),
      );
      expect(config.url).toBe(
        `https://github.com/${owner}/${fixtureRepos[0]}/hook`,
      );
      expect(config.content_type).toBe("form");
      expect(config.secret).toBe("********");
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("webhook")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "unfixable drift fails with the settings URL and passes after the UI fix",
  (stack) =>
    Effect.gen(function* () {
      const id = "drift";
      yield* cleanup(stack, appName(id));

      const app = yield* autopilot()
        .run(stack.deploy(deployApp(appProps(id))))
        .pipe(withManualStepTimeout("2 minutes"));

      // Raising a permission has no API: without a browser session, even with
      // a human at the terminal the deploy must stop, name the drift, and
      // point at the settings page.
      const human = autopilot({ idle: true });
      const error = failureOf(
        yield* Effect.exit(
          human.run(
            stack.deploy(
              deployApp(appProps(id, { permissions: { issues: "write" } })),
            ),
          ),
        ),
      );
      const settingsUrl = `https://github.com/organizations/${owner}/settings/apps/${app.slug}/permissions`;
      expect(error).toMatchObject({
        _tag: "GitHubAppDrift",
        url: settingsUrl,
        message: expect.stringContaining(settingsUrl),
        fields: [
          {
            field: "permissions",
            desired: { issues: "write" },
            live: { issues: "read" },
          },
        ],
      });
      expect(isUserFacing(error)).toBe(true);
      expect(human.launched).toEqual([]);

      yield* setAppPermission({
        slug: app.slug,
        permission: "issues",
        access: "write",
      });

      // The failed deploy left the row `updating`, which drift detection
      // leaves to the next deploy.
      const detected = yield* Drift.detect(identity(stack));
      expect(detected.resources["App"]?.action).toBe("skipped");

      const fixed = yield* autopilot().run(
        stack.deploy(
          deployApp(appProps(id, { permissions: { issues: "write" } })),
        ),
      );
      expect(fixed.appId).toBe(app.appId);
      expect(fixed.permissions).toMatchObject({ issues: "write" });
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("drift")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "an out-of-band permission change is drift that repair reports with the settings URL",
  (stack) =>
    Effect.gen(function* () {
      const id = "oobperm";
      yield* cleanup(stack, appName(id));

      const app = yield* autopilot()
        .run(stack.deploy(deployApp(appProps(id))))
        .pipe(withManualStepTimeout("2 minutes"));

      // A deploy with unchanged props never reaches the provider; drift
      // detection is what observes a change made in the GitHub UI.
      yield* setAppPermission({
        slug: app.slug,
        permission: "issues",
        access: "write",
      });
      const detected = yield* Drift.detect(identity(stack));
      expect(detected.resources["App"]?.action).toBe("drifted");

      const human = autopilot({ idle: true });
      const repair = failureOf(
        yield* Effect.exit(human.run(Drift.repair(identity(stack)))),
      );
      const settingsUrl = `https://github.com/organizations/${owner}/settings/apps/${app.slug}/permissions`;
      expect(repair).toMatchObject({
        _tag: "DriftResourceError",
        cause: {
          _tag: "GitHubAppDrift",
          url: settingsUrl,
          message: expect.stringContaining(settingsUrl),
          fields: [
            {
              field: "permissions",
              desired: { issues: "read" },
              live: { issues: "write" },
            },
          ],
        },
      });
      expect(human.launched).toEqual([]);

      yield* setAppPermission({
        slug: app.slug,
        permission: "issues",
        access: "read",
      });
      const reverted = yield* Drift.detect(identity(stack));
      expect(reverted.resources["App"]?.action).toBe("unchanged");
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("oobperm")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "registers, redeploys and destroys unattended",
  (stack) =>
    Effect.gen(function* () {
      const props = appProps("unattended");
      yield* cleanup(stack, props.name);

      const human = autopilot();
      const app = yield* human
        .run(unattended(stack.deploy(deployApp(props))))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(app.slug).toBe(props.name);
      expect(yield* appExists(yield* Octokit, props.name)).toBe(true);
      expect(human.prompts).toEqual([]);

      const again = yield* human.run(
        unattended(stack.deploy(deployApp(props))),
      );
      expect(again.appId).toBe(app.appId);
      expect(human.prompts).toEqual([]);

      yield* human
        .run(unattended(stack.destroy()))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(human.prompts).toEqual([]);
      expect(human.launched).toContain(
        `https://github.com/organizations/${owner}/settings/apps/${props.name}/advanced`,
      );
      expect(yield* appExists(yield* Octokit, props.name)).toBe(false);
      expect(yield* persistedApp(stack)).toBeUndefined();
    }).pipe(
      Effect.ensuring(
        cleanup(stack, appName("unattended")).pipe(Effect.ignore),
      ),
    ),
  { ...browserTest, timeout: 240_000 },
);

test.provider(
  "repairs drift unattended",
  (stack) =>
    Effect.gen(function* () {
      const id = "repair";
      yield* cleanup(stack, appName(id));

      const app = yield* autopilot()
        .run(stack.deploy(deployApp(appProps(id))))
        .pipe(withManualStepTimeout("2 minutes"));

      yield* setAppPermission({
        slug: app.slug,
        permission: "issues",
        access: "write",
      });

      const props = appProps(id, {
        description: "alchemy GitHub App drift repair test",
      });
      const human = autopilot();
      const repaired = yield* human
        .run(unattended(stack.deploy(deployApp(props))))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(repaired.appId).toBe(app.appId);
      expect(repaired.permissions).toMatchObject({ issues: "read" });
      expect(human.prompts).toEqual([]);
      const settingsUrl = `https://github.com/organizations/${owner}/settings/apps/${app.slug}`;
      expect(human.launched).toContain(settingsUrl);
      expect(human.launched).toContain(`${settingsUrl}/permissions`);

      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(app.appId, app.privateKey).rest.apps.getAuthenticated(),
      );
      expect(live ? GitHub.appDrift(props, live) : undefined).toEqual([]);

      const detected = yield* Drift.detect(identity(stack));
      expect(detected.resources["App"]?.action).toBe("unchanged");
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("repair")).pipe(Effect.ignore)),
    ),
  { ...browserTest, timeout: 240_000 },
);

test.provider(
  "destroy without a human fails loudly and keeps state",
  (stack) =>
    Effect.gen(function* () {
      const id = "keepstate";
      yield* cleanup(stack, appName(id));

      const app = yield* autopilot()
        .run(stack.deploy(deployApp(appProps(id))))
        .pipe(withManualStepTimeout("2 minutes"));
      const advancedUrl = `https://github.com/organizations/${owner}/settings/apps/${app.slug}/advanced`;

      const noTerminal = destroyFailures(
        failureOf(yield* Effect.exit(stack.destroy())),
      );
      expect(noTerminal?.message).toEqual(expect.stringContaining(advancedUrl));
      expect(noTerminal?.causes).toMatchObject([
        {
          _tag: "GitHubManualStepRequired",
          step: "delete-app",
          url: advancedUrl,
          message: expect.stringContaining(advancedUrl),
        },
      ]);
      expect(isUserFacing(noTerminal?.causes[0])).toBe(true);
      expect(yield* appExists(yield* Octokit, app.slug)).toBe(true);
      expect(yield* persistedApp(stack)).toBeDefined();

      const idle = autopilot({ idle: true });
      const timedOut = destroyFailures(
        failureOf(
          yield* Effect.exit(
            idle.run(stack.destroy()).pipe(withManualStepTimeout("5 seconds")),
          ),
        ),
      );
      expect(timedOut?.message).toEqual(expect.stringContaining(advancedUrl));
      expect(timedOut?.causes).toMatchObject([
        {
          _tag: "GitHubManualStepTimeout",
          step: "delete-app",
          url: advancedUrl,
        },
      ]);
      expect(isUserFacing(timedOut?.causes[0])).toBe(true);
      expect(idle.launched).toEqual([advancedUrl]);
      expect(yield* appExists(yield* Octokit, app.slug)).toBe(true);
      expect(yield* persistedApp(stack)).toBeDefined();

      yield* autopilot()
        .run(stack.destroy())
        .pipe(withManualStepTimeout("2 minutes"));
      expect(yield* appExists(yield* Octokit, app.slug)).toBe(false);
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("keepstate")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "re-registers an app deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      const id = "oob";
      const props = appProps(id);
      yield* cleanup(stack, props.name);

      const app = yield* autopilot()
        .run(stack.deploy(deployApp(props)))
        .pipe(withManualStepTimeout("2 minutes"));
      yield* deleteAppInUi(app.slug);

      // A deploy with unchanged props never reaches the provider; drift
      // detection notices the app is gone and repair re-registers it.
      const detected = yield* Drift.detect(identity(stack));
      expect(detected.resources["App"]?.action).toBe("missing");

      const noTerminal = failureOf(
        yield* Effect.exit(Drift.repair(identity(stack))),
      );
      expect(noTerminal).toMatchObject({
        _tag: "DriftResourceError",
        cause: { _tag: "GitHubManualStepRequired", step: "register-app" },
      });

      const human = autopilot();
      const repaired = yield* human
        .run(Drift.repair(identity(stack)))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(repaired.resources["App"]?.action).toBe("recreated");
      const recreated: GitHub.App["Attributes"] =
        repaired.resources["App"]?.attr;
      expect(recreated.appId).not.toBe(app.appId);
      expect(recreated.slug).toBe(props.name);
      expect(human.launched).toHaveLength(1);
      const { data: live } = yield* Effect.tryPromise(() =>
        appOctokit(
          recreated.appId,
          recreated.privateKey,
        ).rest.apps.getAuthenticated(),
      );
      expect(live?.id).toBe(recreated.appId);
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("oob")).pipe(Effect.ignore)),
    ),
  browserTest,
);

test.provider(
  "retains the registration by default and adopts it back with its private key",
  (stack) =>
    Effect.gen(function* () {
      const id = "adopt";
      const props = appProps(id);
      yield* cleanup(stack, props.name);

      const app = yield* autopilot()
        .run(stack.deploy(GitHub.App("App", props)))
        .pipe(withManualStepTimeout("2 minutes"));

      // Default retain: destroy drops the state and never opens a browser.
      yield* expectQuietDestroy(stack);
      expect(yield* appExists(yield* Octokit, props.name)).toBe(true);

      // Found by slug with no state, the registration is someone else's and
      // adopting it needs the key...
      const settingsUrl = `https://github.com/organizations/${owner}/settings/apps/${props.name}`;
      const keyless = failureOf(
        yield* Effect.exit(stack.deploy(deployApp(props))),
      );
      expect(keyless).toMatchObject({
        _tag: "GitHubAppAdoptionNeedsKey",
        url: settingsUrl,
        message: expect.stringContaining(settingsUrl),
      });
      expect(isUserFacing(keyless)).toBe(true);

      const withKey = { ...props, privateKey: app.privateKey };
      const foreign = failureOf(
        yield* Effect.exit(stack.deploy(deployApp(withKey))),
      );
      expect(foreign).toMatchObject({ _tag: "OwnedBySomeoneElse" });
      expect(yield* appExists(yield* Octokit, props.name)).toBe(true);

      // ...until --adopt takes it over, without a browser.
      const quiet = autopilot();
      const adopted = yield* quiet.run(
        stack.deploy(deployApp(withKey).pipe(adopt(true))),
      );
      expect(adopted.appId).toBe(app.appId);
      expect(adopted.slug).toBe(props.name);
      expect(adopted.clientSecret).toBeUndefined();
      expect(Redacted.value(adopted.privateKey)).toBe(
        Redacted.value(app.privateKey),
      );
      expect(quiet.launched).toEqual([]);
      expect(quiet.prompts).toEqual([]);

      // Opted into destroy(): the browser delete step runs.
      const remover = autopilot();
      yield* remover
        .run(stack.destroy())
        .pipe(withManualStepTimeout("2 minutes"));
      expect(remover.launched).toEqual([`${settingsUrl}/advanced`]);
      expect(yield* appExists(yield* Octokit, props.name)).toBe(false);
    }).pipe(
      Effect.ensuring(cleanup(stack, appName("adopt")).pipe(Effect.ignore)),
    ),
  browserTest,
);

// The browser profile is signed in as a user; a private user app is not
// visible to the test token, so existence is checked as the app itself.
const cleanupUserApp = (stack: Test.ScratchStack, slug: string) =>
  Effect.gen(function* () {
    yield* autopilot().run(stack.destroy()).pipe(Effect.ignore);
    yield* deleteAppInUi(slug, { user: true }).pipe(Effect.ignore);
  });

test.provider(
  "registers under the signed-in user when owner is omitted",
  (stack) =>
    Effect.gen(function* () {
      const props = appProps("user", { owner: undefined });
      yield* cleanupUserApp(stack, props.name);

      const human = autopilot();
      const app = yield* human
        .run(stack.deploy(deployApp(props)))
        .pipe(withManualStepTimeout("2 minutes"));
      expect(human.launched).toHaveLength(1);
      expect(app.slug).toBe(props.name);
      expect(app.owner).not.toBe(owner);
      expect(app.htmlUrl).toBe(`https://github.com/apps/${props.name}`);

      const remover = autopilot();
      yield* remover
        .run(stack.destroy())
        .pipe(withManualStepTimeout("2 minutes"));
      expect(remover.launched).toEqual([
        `https://github.com/settings/apps/${props.name}/advanced`,
      ]);
      const gone = yield* Effect.exit(
        Effect.tryPromise(() =>
          appOctokit(app.appId, app.privateKey).rest.apps.getAuthenticated(),
        ),
      );
      expect(gone._tag).toBe("Failure");
    }).pipe(
      Effect.ensuring(
        cleanupUserApp(stack, appName("user")).pipe(Effect.ignore),
      ),
    ),
  browserTest,
);

// Manual sweep for apps orphaned by a killed run (no state, nothing to
// destroy): `pnpm test test/GitHub/App.test.ts --tags github-app-sweep`.
test.provider(
  "sweep leftover test apps",
  () =>
    Effect.gen(function* () {
      for (const slug of yield* listTestAppsInUi) {
        yield* deleteAppInUi(slug);
      }
      expect(yield* listTestAppsInUi).toEqual([]);
    }),
  {
    tags: [...apiTags, "browser", "github-app-sweep"],
    optInTags: ["github-app-sweep"],
    timeout: 300_000,
  },
);
