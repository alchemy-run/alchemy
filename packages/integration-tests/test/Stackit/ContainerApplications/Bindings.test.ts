import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sca from "@distilled.cloud/stackit/sca";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import ContainerApplicationsBindingsWorker, {
  Apps,
  Backend,
  Login,
  Secret,
} from "./fixtures/worker.ts";
import { noApplications } from "./helpers.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitScaBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ContainerApplicationsBindingsWorker;
    const apps = yield* Apps;
    const backend = yield* Backend;
    const secret = yield* Secret;
    const login = yield* Login;
    return {
      url: worker.url.as<string>(),
      projectId: apps.projectId,
      region: apps.region,
      environmentId: apps.environmentId,
      applicationId: backend.applicationId,
      secretKey: secret.key,
      server: login.server,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const timeout = { timeout: 180_000 } as const;

describe
  .skipIf(noApplications)
  .sequential(
    "STACKIT Container Applications bindings on a Cloudflare Worker",
    { tags: [...stackitTags("containerapplications", "bindings"), "provider:cloudflare"] },
    () => {
      const stack = beforeAll(deploy(Stack), { timeout: 1_500_000 });
      afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_200_000 });

      // A fresh workers.dev URL, the created key and its memberships take a while to
      // propagate: retry until the route answers `ok`, then report the last answer so a real
      // failure shows its STACKIT error.
      const call = (route: string, params: Record<string, string> = {}) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          const query = new URLSearchParams(params).toString();
          return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
            Effect.timeout("30 seconds"),
            Effect.flatMap((response) => response.json),
            Effect.map((body) => body as Body),
            Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
            Effect.catch((body) => Effect.succeed(body as Body)),
          );
        });

      describe("GetEnvironment", () => {
        test(
          "reads the bound environment",
          Effect.gen(function* () {
            const { environmentId } = yield* stack;
            const body = yield* call("/get-environment");
            expectOk(body);
            expect(body.result).toMatchObject({ id: environmentId });
          }),
          timeout,
        );
      });

      describe("ListEnvironments", () => {
        test(
          "lists the bound environment among its project's",
          Effect.gen(function* () {
            const { environmentId } = yield* stack;
            const body = yield* call("/list-environments");
            expectOk(body);
            expect(body.result.ids).toContain(environmentId);
          }),
          timeout,
        );
      });

      describe("ListApplications", () => {
        test(
          "lists the application in the bound environment",
          Effect.gen(function* () {
            const { applicationId } = yield* stack;
            const body = yield* call("/list-applications");
            expectOk(body);
            expect(body.result.ids).toContain(applicationId);
          }),
          timeout,
        );
      });

      describe("ListProjectApplications", () => {
        test(
          "lists the application among its project's",
          Effect.gen(function* () {
            const { applicationId } = yield* stack;
            const body = yield* call("/list-project-applications");
            expectOk(body);
            expect(body.result.ids).toContain(applicationId);
          }),
          timeout,
        );
      });

      describe("GetOverview", () => {
        test(
          "counts the project's applications",
          Effect.gen(function* () {
            const body = yield* call("/get-overview");
            expectOk(body);
            expect(body.result.summary.applicationsTotal).toBeGreaterThanOrEqual(1);
          }),
          timeout,
        );
      });

      describe("ListEnvironmentSecrets", () => {
        test(
          "lists the secret in the bound environment",
          Effect.gen(function* () {
            const { secretKey } = yield* stack;
            const body = yield* call("/list-secrets");
            expectOk(body);
            expect(body.result.keys).toContain(secretKey);
          }),
          timeout,
        );
      });

      describe("ListEnvironmentRegistries", () => {
        test(
          "lists the login in the bound environment",
          Effect.gen(function* () {
            const { server } = yield* stack;
            const body = yield* call("/list-registries");
            expectOk(body);
            expect(body.result.servers).toContain(server);
          }),
          timeout,
        );
      });

      describe("GetApplication", () => {
        test(
          "reads the bound application",
          Effect.gen(function* () {
            const { applicationId } = yield* stack;
            const body = yield* call("/get-application");
            expectOk(body);
            expect(body.result).toMatchObject({
              id: applicationId,
              status: "CURRENT_STATUS_RUNNING",
            });
          }),
          timeout,
        );
      });

      describe("GetApplicationEvents", () => {
        test(
          "reads the bound application's events",
          Effect.gen(function* () {
            const body = yield* call("/get-events");
            expectOk(body);
            expect(body.result.count).toBeGreaterThanOrEqual(1);
          }),
          timeout,
        );
      });

      describe("GetApplicationLogs", () => {
        test(
          "reads a running instance's logs",
          Effect.gen(function* () {
            const body = yield* call("/get-logs");
            expectOk(body);
            // nginx logs its startup.
            expect(body.result.count).toBeGreaterThanOrEqual(1);
          }),
          timeout,
        );
      });

      describe("UpdateApplication", () => {
        test.provider(
          "stops the bound application and starts it again",
          (_stack) =>
            Effect.gen(function* () {
              const { projectId, region, environmentId, applicationId } = yield* stack;
              const scope = {
                projectId: projectId!,
                region: region!,
                environmentId: environmentId!,
                applicationId: applicationId!,
              };
              const settle = (stopped: boolean) =>
                sca.getApplication(scope).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("5 seconds"),
                    until: (app) =>
                      (app.stopped ?? false) === stopped &&
                      app.status?.current ===
                        (stopped ? "CURRENT_STATUS_NONE" : "CURRENT_STATUS_RUNNING"),
                    times: 36,
                  }),
                );

              expectOk(yield* call("/set-stopped", { stopped: "true" }));
              const stopped = yield* settle(true);
              expect(stopped.stopped).toEqual(true);

              expectOk(yield* call("/set-stopped", { stopped: "false" }));
              const started = yield* settle(false);
              expect(started.status?.current).toEqual("CURRENT_STATUS_RUNNING");
            }),
          { timeout: 480_000 },
        );
      });
    },
  );
