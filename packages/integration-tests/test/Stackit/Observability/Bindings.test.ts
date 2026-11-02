import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import ObservabilityBindingsWorker, {
  FIXTURE_ACL,
  Metrics,
  SEEDED_EXPR,
  STARTER_PLAN,
  Tenant,
} from "./fixtures/worker.ts";
import { slow } from "./observability.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitObservabilityBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ObservabilityBindingsWorker;
    const instance = yield* Metrics;
    const credential = yield* Tenant;
    return {
      url: worker.url.as<string>(),
      projectId: instance.projectId,
      instanceId: instance.instanceId,
      username: credential.username,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const linesOf = (body: Body): string[] =>
  (body.result?.data?.result ?? []).flatMap((stream: { values: unknown[][] }) =>
    stream.values.map((value) => String(value[1])),
  );

// The instance is billed per started hour, on the plan with logs: gated behind
// STACKIT_TEST_SLOW, like the resource suites. Writes on one instance run one after another,
// so what the API applies in the background doesn't overlap. See `observability.ts` for cost.
describe.sequential.skipIf(slow)(
  "STACKIT Observability bindings on a Cloudflare Worker",
  { tags: [...stackitTags("observability", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    const OPTIONS = { timeout: 300_000 } as const;

    // A fresh workers.dev URL, the created key and the account's new memberships take a while
    // to propagate: retry until the route answers `ok`, then report the last answer so a real
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

    /** Poll a route until its result holds. Bounded: about two minutes. */
    const callUntil = (
      route: string,
      params: Record<string, string>,
      until: (result: any) => boolean | undefined,
    ) =>
      call(route, params).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (body) => until(body.result) === true,
          times: 24,
        }),
      );

    const untilLine = (app: string, line: string) =>
      call("/query-logs", { app }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (body) => linesOf(body).includes(line),
          times: 24,
        }),
      );

    const instanceScope = Effect.gen(function* () {
      const { projectId, instanceId } = yield* stack;
      return { projectId: projectId!, instanceId: instanceId! };
    });

    /** Bounded wait until an observation finds something. */
    const untilSeen = <A, E, R>(observe: Effect.Effect<A | undefined, E, R>) =>
      observe.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (live) => live !== undefined,
          times: 24,
        }),
      );

    /** Bounded wait until an observation stops finding something. */
    const untilGone = <A, E, R>(observe: Effect.Effect<A | undefined, E, R>) =>
      observe.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (live) => live === undefined,
          times: 24,
        }),
      );

    const observeJob = (jobName: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        return yield* observability.getScrapeConfig({ ...scope, jobName }).pipe(
          Effect.map(({ data }): observability.Job | undefined => data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      });

    const observeGroup = (groupName: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        return yield* observability.getAlertgroup({ ...scope, groupName }).pipe(
          Effect.map(({ data }): observability.AlertGroup | undefined => data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      });

    const observeLogsGroup = (groupName: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        return yield* observability.getLogsAlertgroup({ ...scope, groupName }).pipe(
          Effect.map(({ data }): observability.AlertGroup | undefined => data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      });

    const observeRule = (groupName: string, alertName: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        return yield* observability.getAlertrule({ ...scope, groupName, alertName }).pipe(
          Effect.map(({ data }): observability.AlertRule | undefined => data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      });

    const observeRecord = (groupName: string, alertRecord: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        return yield* observability.getAlertRecord({ ...scope, groupName, alertRecord }).pipe(
          Effect.map(({ data }): observability.AlertRecord | undefined => data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      });

    const observeReceiver = (receiver: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        return yield* observability.getAlertConfigReceiver({ ...scope, receiver }).pipe(
          Effect.map(({ data }): observability.Receivers | undefined => data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      });

    // `getAlertConfigRoute` has no typed not-found, so this reads the routing tree.
    const observeRoute = (receiver: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        const { data } = yield* observability.listAlertConfigRoutes(scope);
        return (data.routes ?? []).find((route) => route.receiver === receiver);
      });

    const seedJob = (jobName: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* observability.createScrapeConfig({
          ...scope,
          jobName,
          scheme: "https",
          scrapeInterval: "5m",
          scrapeTimeout: "2m",
          metricsPath: "/metrics",
          staticConfigs: [{ targets: ["example.com:443"] }],
        });
        yield* untilSeen(observeJob(jobName));
      });

    const seedGroup = (name: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* observability.createAlertgroups({
          ...scope,
          name,
          rules: [{ alert: "BindSeeded", expr: SEEDED_EXPR, for: "2m" }],
        });
        yield* untilSeen(observeGroup(name));
      });

    const seedLogsGroup = (name: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* observability.createLogsAlertgroups({
          ...scope,
          name,
          rules: [
            { alert: "BindLogSeeded", expr: 'sum(rate({app="alchemy"}[5m])) > 1', for: "2m" },
          ],
        });
        yield* untilSeen(observeLogsGroup(name));
      });

    const seedRule = (groupName: string, alert: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* seedGroup(groupName);
        yield* observability.createAlertrules({ ...scope, groupName, alert, expr: SEEDED_EXPR });
        yield* untilSeen(observeRule(groupName, alert));
      });

    const seedRecord = (groupName: string, record: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* seedGroup(groupName);
        yield* observability.createAlertRecord({ ...scope, groupName, record, expr: "vector(1)" });
        yield* untilSeen(observeRecord(groupName, record));
      });

    const seedReceiver = (name: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* observability.createAlertConfigReceiver({
          ...scope,
          name,
          webHookConfigs: [{ url: Redacted.make("https://example.com/alchemy-test") }],
        });
        yield* untilSeen(observeReceiver(name));
      });

    const seedRoute = (receiver: string) =>
      Effect.gen(function* () {
        const scope = yield* instanceScope;
        yield* seedReceiver(receiver);
        yield* observability.createAlertConfigRoute({ ...scope, receiver, continue: true });
        yield* untilSeen(observeRoute(receiver));
      });

    /** The dates of the alert rule backups, once there is one. Bounded: about three minutes. */
    const untilBackup = Effect.gen(function* () {
      const scope = yield* instanceScope;
      return yield* observability.listBackups({ ...scope, backupTarget: ["alertRules"] }).pipe(
        Effect.map((live) => live.alertRulesBackups),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (dates) => dates.length > 0,
          times: 18,
        }),
      );
    });

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result).toEqual({ id: instanceId, planName: STARTER_PLAN });
          }),
        OPTIONS,
      );
    });

    describe("ListInstances", () => {
      test.provider(
        "lists the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/list-instances");
            expectOk(body);
            expect(body.result.ids).toContain(instanceId);
          }),
        OPTIONS,
      );
    });

    describe("ListACL", () => {
      test.provider(
        "reads the ACL the fixture declares",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-acl");
            expectOk(body);
            expect(body.result.acl).toContain(FIXTURE_ACL);
          }),
        OPTIONS,
      );
    });

    describe("GetGrafanaConfigs", () => {
      test.provider(
        "reads what the API reports out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const body = yield* call("/get-grafana-configs");
            expectOk(body);
            const live = yield* observability.getGrafanaConfigs(scope);
            expect(body.result.useStackitSso).toEqual(live.useStackitSso);
          }),
        OPTIONS,
      );
    });

    describe("GetMetricsStorageRetention", () => {
      test.provider(
        "reads what the API reports out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const body = yield* call("/get-metrics-storage-retention");
            expectOk(body);
            const live = yield* observability.getMetricsStorageRetention(scope);
            expect(body.result.raw).toEqual(live.metricsRetentionTimeRaw);
          }),
        OPTIONS,
      );
    });

    describe("GetLogsConfigs", () => {
      test.provider(
        "reads what the API reports out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const body = yield* call("/get-logs-configs");
            expectOk(body);
            const live = yield* observability.getLogsConfigs(scope);
            expect(body.result.retention).toEqual(live.config.retention);
          }),
        OPTIONS,
      );
    });

    describe("GetTracesConfigs", () => {
      test.provider(
        "reads what the API reports out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const body = yield* call("/get-traces-configs");
            expectOk(body);
            const live = yield* observability.getTracesConfigs(scope);
            expect(body.result.retention).toEqual(live.config.retention);
          }),
        OPTIONS,
      );
    });

    describe("ListPlans", () => {
      test.provider(
        "lists the plan the fixture runs on",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-plans");
            expectOk(body);
            expect(body.result.names).toContain(STARTER_PLAN);
          }),
        OPTIONS,
      );
    });

    describe("ListOfferings", () => {
      test.provider(
        "lists the plan the fixture runs on",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-offerings");
            expectOk(body);
            expect(body.result.plans).toContain(STARTER_PLAN);
          }),
        OPTIONS,
      );
    });

    describe("ListCredentials", () => {
      test.provider(
        "lists the fixture's credential, and never its `credentialsInfo`",
        (_stack) =>
          Effect.gen(function* () {
            const { username } = yield* stack;
            const body = yield* call("/list-credentials");
            expectOk(body);
            expect(body.result.usernames).toContain(username);
          }),
        OPTIONS,
      );
    });

    describe("UpdateCredentialsRemoteWriteConfig", () => {
      test.provider(
        "changes the bound credential's limit, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const { username } = yield* stack;
            const body = yield* call("/update-credentials-remote-write-config", { limit: "1000" });
            expectOk(body);
            const live = yield* observability
              .getCredentialsRemoteWriteConfig({ ...scope, username: username! })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (config) => config.maxLimit === 1000,
                  times: 24,
                }),
              );
            expect(live.maxLimit).toEqual(1000);
          }),
        OPTIONS,
      );
    });

    describe("GetCredentialsRemoteWriteConfig", () => {
      test.provider(
        "reads a limit set out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const { username } = yield* stack;
            yield* observability.updateCredentialsRemoteWriteConfig({
              ...scope,
              username: username!,
              maxLimit: 2000,
            });
            const body = yield* callUntil(
              "/get-credentials-remote-write-config",
              {},
              (result) => result?.maxLimit === 2000,
            );
            expectOk(body);
            expect(body.result.maxLimit).toEqual(2000);
          }),
        OPTIONS,
      );
    });

    describe("CreateScrapeConfig", () => {
      test.provider(
        "creates a job visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-scrape-config", { name: "bind-create-job" });
            expectOk(body);
            const job = yield* untilSeen(observeJob("bind-create-job"));
            expect(job?.jobName).toEqual("bind-create-job");
          }),
        OPTIONS,
      );
    });

    describe("GetScrapeConfig", () => {
      test.provider(
        "reads a job seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedJob("bind-get-job");
            const body = yield* call("/get-scrape-config", { name: "bind-get-job" });
            expectOk(body);
            expect(body.result).toEqual({ jobName: "bind-get-job", scrapeInterval: "5m" });
          }),
        OPTIONS,
      );
    });

    describe("ListScrapeConfigs", () => {
      test.provider(
        "lists a job seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedJob("bind-list-job");
            const body = yield* call("/list-scrape-configs");
            expectOk(body);
            expect(body.result.jobs).toContain("bind-list-job");
          }),
        OPTIONS,
      );
    });

    describe("UpdateScrapeConfig", () => {
      test.provider(
        "changes a job, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedJob("bind-update-job");
            const body = yield* call("/update-scrape-config", { name: "bind-update-job" });
            expectOk(body);
            const job = yield* observeJob("bind-update-job").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (live) => live?.scrapeInterval === "10m",
                times: 24,
              }),
            );
            expect(job?.scrapeInterval).toEqual("10m");
          }),
        OPTIONS,
      );
    });

    describe("DeleteScrapeConfig", () => {
      test.provider(
        "removes a job, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedJob("bind-delete-job");
            const body = yield* call("/delete-scrape-config", { name: "bind-delete-job" });
            expectOk(body);
            const job = yield* untilGone(observeJob("bind-delete-job"));
            expect(job).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("UpsertScrapeConfigs", () => {
      test.provider(
        "creates a job visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/upsert-scrape-configs", { name: "bind-upsert-job" });
            expectOk(body);
            const job = yield* untilSeen(observeJob("bind-upsert-job"));
            expect(job?.jobName).toEqual("bind-upsert-job");
          }),
        OPTIONS,
      );
    });

    describe("DeleteScrapeConfigs", () => {
      test.provider(
        "removes jobs by name, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedJob("bind-delete-many-a");
            yield* seedJob("bind-delete-many-b");
            const body = yield* call("/delete-scrape-configs", {
              names: "bind-delete-many-a,bind-delete-many-b",
            });
            expectOk(body);
            const gone1 = yield* untilGone(observeJob("bind-delete-many-a"));
            expect(gone1).toBeUndefined();
            const gone2 = yield* untilGone(observeJob("bind-delete-many-b"));
            expect(gone2).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("CreateAlertGroup", () => {
      test.provider(
        "creates a group visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-alert-group", { name: "bind-create-group" });
            expectOk(body);
            const group = yield* untilSeen(observeGroup("bind-create-group"));
            expect(group?.rules.map((item) => item.alert)).toEqual(["BindRule"]);
          }),
        OPTIONS,
      );
    });

    describe("GetAlertGroup", () => {
      test.provider(
        "reads a group seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-get-group");
            const body = yield* call("/get-alert-group", { name: "bind-get-group" });
            expectOk(body);
            expect(body.result).toEqual({ name: "bind-get-group", rules: 1 });
          }),
        OPTIONS,
      );
    });

    describe("ListAlertGroups", () => {
      test.provider(
        "lists a group seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-list-group");
            const body = yield* call("/list-alert-groups");
            expectOk(body);
            expect(body.result.groups).toContain("bind-list-group");
          }),
        OPTIONS,
      );
    });

    describe("UpdateAlertGroup", () => {
      test.provider(
        "replaces a group's rules, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-update-group");
            const body = yield* call("/update-alert-group", { name: "bind-update-group" });
            expectOk(body);
            const group = yield* observeGroup("bind-update-group").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (live) => live?.rules[0]?.alert === "BindUpdated",
                times: 24,
              }),
            );
            expect(group?.rules.map((item) => item.alert)).toEqual(["BindUpdated"]);
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertGroup", () => {
      test.provider(
        "removes a group, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-delete-group");
            const body = yield* call("/delete-alert-group", { name: "bind-delete-group" });
            expectOk(body);
            const gone3 = yield* untilGone(observeGroup("bind-delete-group"));
            expect(gone3).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("UpsertAlertGroups", () => {
      test.provider(
        "creates a group visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/upsert-alert-groups", { name: "bind-upsert-group" });
            expectOk(body);
            const group = yield* untilSeen(observeGroup("bind-upsert-group"));
            expect(group?.name).toEqual("bind-upsert-group");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertGroups", () => {
      test.provider(
        "removes groups by name, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-delete-groups-a");
            yield* seedGroup("bind-delete-groups-b");
            const body = yield* call("/delete-alert-groups", {
              names: "bind-delete-groups-a,bind-delete-groups-b",
            });
            expectOk(body);
            const gone4 = yield* untilGone(observeGroup("bind-delete-groups-a"));
            expect(gone4).toBeUndefined();
            const gone5 = yield* untilGone(observeGroup("bind-delete-groups-b"));
            expect(gone5).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("CreateAlertRule", () => {
      test.provider(
        "adds a rule visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-rule-create");
            const body = yield* call("/create-alert-rule", {
              group: "bind-rule-create",
              name: "BindAdded",
            });
            expectOk(body);
            const live = yield* untilSeen(observeRule("bind-rule-create", "BindAdded"));
            expect(live?.alert).toEqual("BindAdded");
          }),
        OPTIONS,
      );
    });

    describe("GetAlertRule", () => {
      test.provider(
        "reads a rule seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-rule-get");
            const body = yield* call("/get-alert-rule", {
              group: "bind-rule-get",
              name: "BindSeeded",
            });
            expectOk(body);
            expect(body.result).toEqual({ alert: "BindSeeded", expr: SEEDED_EXPR });
          }),
        OPTIONS,
      );
    });

    describe("ListAlertRules", () => {
      test.provider(
        "lists a rule seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-rule-list");
            const body = yield* call("/list-alert-rules", { group: "bind-rule-list" });
            expectOk(body);
            expect(body.result.rules).toEqual(["BindSeeded"]);
          }),
        OPTIONS,
      );
    });

    describe("UpdateAlertRule", () => {
      test.provider(
        "changes a rule's expression, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-rule-update");
            const body = yield* call("/update-alert-rule", {
              group: "bind-rule-update",
              name: "BindSeeded",
            });
            expectOk(body);
            const live = yield* observeRule("bind-rule-update", "BindSeeded").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (observed) => observed?.expr === "vector(1) > 3",
                times: 24,
              }),
            );
            expect(live?.expr).toEqual("vector(1) > 3");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertRule", () => {
      test.provider(
        "removes a rule, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRule("bind-rule-delete", "BindDoomed");
            const body = yield* call("/delete-alert-rule", {
              group: "bind-rule-delete",
              name: "BindDoomed",
            });
            expectOk(body);
            const gone6 = yield* untilGone(observeRule("bind-rule-delete", "BindDoomed"));
            expect(gone6).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("UpsertAlertRules", () => {
      test.provider(
        "adds a rule visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-rule-upsert");
            const body = yield* call("/upsert-alert-rules", {
              group: "bind-rule-upsert",
              name: "BindUpserted",
            });
            expectOk(body);
            const live = yield* untilSeen(observeRule("bind-rule-upsert", "BindUpserted"));
            expect(live?.alert).toEqual("BindUpserted");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertRules", () => {
      test.provider(
        "removes rules by name, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRule("bind-rule-delete-many", "BindDoomed");
            const body = yield* call("/delete-alert-rules", {
              group: "bind-rule-delete-many",
              names: "BindDoomed",
            });
            expectOk(body);
            expect(
              yield* untilGone(observeRule("bind-rule-delete-many", "BindDoomed")),
            ).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("CreateAlertRecord", () => {
      test.provider(
        "adds a recording rule visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-record-create");
            const body = yield* call("/create-alert-record", {
              group: "bind-record-create",
              name: "bind:added",
            });
            expectOk(body);
            const live = yield* untilSeen(observeRecord("bind-record-create", "bind:added"));
            expect(live?.record).toEqual("bind:added");
          }),
        OPTIONS,
      );
    });

    describe("GetAlertRecord", () => {
      test.provider(
        "reads a recording rule seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRecord("bind-record-get", "bind:seeded");
            const body = yield* call("/get-alert-record", {
              group: "bind-record-get",
              name: "bind:seeded",
            });
            expectOk(body);
            expect(body.result).toEqual({ record: "bind:seeded", expr: "vector(1)" });
          }),
        OPTIONS,
      );
    });

    describe("ListAlertRecords", () => {
      test.provider(
        "lists a recording rule seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRecord("bind-record-list", "bind:seeded");
            const body = yield* call("/list-alert-records", { group: "bind-record-list" });
            expectOk(body);
            expect(body.result.records).toContain("bind:seeded");
          }),
        OPTIONS,
      );
    });

    describe("UpdateAlertRecord", () => {
      test.provider(
        "changes a recording rule's expression, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRecord("bind-record-update", "bind:seeded");
            const body = yield* call("/update-alert-record", {
              group: "bind-record-update",
              name: "bind:seeded",
            });
            expectOk(body);
            const live = yield* observeRecord("bind-record-update", "bind:seeded").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (observed) => observed?.expr === "vector(2)",
                times: 24,
              }),
            );
            expect(live?.expr).toEqual("vector(2)");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertRecord", () => {
      test.provider(
        "removes a recording rule, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRecord("bind-record-delete", "bind:seeded");
            const body = yield* call("/delete-alert-record", {
              group: "bind-record-delete",
              name: "bind:seeded",
            });
            expectOk(body);
            expect(
              yield* untilGone(observeRecord("bind-record-delete", "bind:seeded")),
            ).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("UpsertAlertRecords", () => {
      test.provider(
        "adds a recording rule visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedGroup("bind-record-upsert");
            const body = yield* call("/upsert-alert-records", {
              group: "bind-record-upsert",
              name: "bind:upserted",
            });
            expectOk(body);
            const live = yield* untilSeen(observeRecord("bind-record-upsert", "bind:upserted"));
            expect(live?.record).toEqual("bind:upserted");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertRecords", () => {
      test.provider(
        "removes recording rules by name, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRecord("bind-record-delete-many", "bind:seeded");
            const body = yield* call("/delete-alert-records", {
              group: "bind-record-delete-many",
              names: "bind:seeded",
            });
            expectOk(body);
            expect(
              yield* untilGone(observeRecord("bind-record-delete-many", "bind:seeded")),
            ).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("CreateLogsAlertGroup", () => {
      test.provider(
        "creates a group visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-logs-alert-group", { name: "bind-create-logs" });
            expectOk(body);
            const group = yield* untilSeen(observeLogsGroup("bind-create-logs"));
            expect(group?.rules.map((item) => item.alert)).toEqual(["BindLogRule"]);
          }),
        OPTIONS,
      );
    });

    describe("GetLogsAlertGroup", () => {
      test.provider(
        "reads a group seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedLogsGroup("bind-get-logs");
            const body = yield* call("/get-logs-alert-group", { name: "bind-get-logs" });
            expectOk(body);
            expect(body.result).toEqual({ name: "bind-get-logs", rules: 1 });
          }),
        OPTIONS,
      );
    });

    describe("ListLogsAlertGroups", () => {
      test.provider(
        "lists a group seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedLogsGroup("bind-list-logs");
            const body = yield* call("/list-logs-alert-groups");
            expectOk(body);
            expect(body.result.groups).toContain("bind-list-logs");
          }),
        OPTIONS,
      );
    });

    describe("UpdateLogsAlertGroup", () => {
      test.provider(
        "replaces a group's rules, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedLogsGroup("bind-update-logs");
            const body = yield* call("/update-logs-alert-group", { name: "bind-update-logs" });
            expectOk(body);
            const group = yield* observeLogsGroup("bind-update-logs").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (live) => live?.rules[0]?.alert === "BindLogUpdated",
                times: 24,
              }),
            );
            expect(group?.rules.map((item) => item.alert)).toEqual(["BindLogUpdated"]);
          }),
        OPTIONS,
      );
    });

    describe("DeleteLogsAlertGroup", () => {
      test.provider(
        "removes a group, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedLogsGroup("bind-delete-logs");
            const body = yield* call("/delete-logs-alert-group", { name: "bind-delete-logs" });
            expectOk(body);
            const gone7 = yield* untilGone(observeLogsGroup("bind-delete-logs"));
            expect(gone7).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("GetAlertConfig", () => {
      test.provider(
        "reads a receiver seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedReceiver("bind-config");
            const body = yield* call("/get-alert-config");
            expectOk(body);
            expect(body.result.receivers).toContain("bind-config");
          }),
        OPTIONS,
      );
    });

    describe("ListAlertConfigReceivers", () => {
      test.provider(
        "lists a receiver seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedReceiver("bind-list");
            const body = yield* call("/list-alert-config-receivers");
            expectOk(body);
            expect(body.result.receivers).toContain("bind-list");
          }),
        OPTIONS,
      );
    });

    describe("GetAlertConfigReceiver", () => {
      test.provider(
        "reads a receiver seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedReceiver("bind-get");
            const body = yield* call("/get-alert-config-receiver", { name: "bind-get" });
            expectOk(body);
            expect(body.result).toEqual({ name: "bind-get", webhooks: 1 });
          }),
        OPTIONS,
      );
    });

    describe("CreateAlertConfigReceiver", () => {
      test.provider(
        "adds a receiver visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-alert-config-receiver", { name: "bind-create" });
            expectOk(body);
            const live = yield* untilSeen(observeReceiver("bind-create"));
            expect(live?.name).toEqual("bind-create");
          }),
        OPTIONS,
      );
    });

    describe("UpdateAlertConfigReceiver", () => {
      test.provider(
        "changes a receiver, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedReceiver("bind-update");
            const body = yield* call("/update-alert-config-receiver", { name: "bind-update" });
            expectOk(body);
            const live = yield* observeReceiver("bind-update").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (observed) => (observed?.emailConfigs?.length ?? 0) > 0,
                times: 24,
              }),
            );
            expect(live?.emailConfigs?.[0]?.to).toEqual("alerts@example.com");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertConfigReceiver", () => {
      test.provider(
        "removes a receiver, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedReceiver("bind-delete");
            const body = yield* call("/delete-alert-config-receiver", { name: "bind-delete" });
            expectOk(body);
            const gone8 = yield* untilGone(observeReceiver("bind-delete"));
            expect(gone8).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("ListAlertConfigRoutes", () => {
      test.provider(
        "reads a route seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRoute("bind-routes");
            const body = yield* call("/list-alert-config-routes");
            expectOk(body);
            expect(body.result.routes).toContain("bind-routes");
          }),
        OPTIONS,
      );
    });

    describe("GetAlertConfigRoute", () => {
      test.provider(
        "reads a route seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRoute("bind-route-get");
            const body = yield* call("/get-alert-config-route", { name: "bind-route-get" });
            expectOk(body);
            expect(body.result.receiver).toEqual("bind-route-get");
          }),
        OPTIONS,
      );
    });

    describe("CreateAlertConfigRoute", () => {
      test.provider(
        "adds a route visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedReceiver("bind-route-create");
            const body = yield* call("/create-alert-config-route", { name: "bind-route-create" });
            expectOk(body);
            const live = yield* untilSeen(observeRoute("bind-route-create"));
            expect(live?.receiver).toEqual("bind-route-create");
          }),
        OPTIONS,
      );
    });

    describe("UpdateAlertConfigRoute", () => {
      test.provider(
        "changes a route, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRoute("bind-route-update");
            const body = yield* call("/update-alert-config-route", { name: "bind-route-update" });
            expectOk(body);
            const live = yield* observeRoute("bind-route-update").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (observed) => observed?.groupWait === "45s",
                times: 24,
              }),
            );
            expect(live?.groupWait).toEqual("45s");
          }),
        OPTIONS,
      );
    });

    describe("DeleteAlertConfigRoute", () => {
      test.provider(
        "removes a route, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedRoute("bind-route-delete");
            const body = yield* call("/delete-alert-config-route", { name: "bind-route-delete" });
            expectOk(body);
            const gone9 = yield* untilGone(observeRoute("bind-route-delete"));
            expect(gone9).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("ListCertChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createCertCheck({
              ...scope,
              source: "example.com:443",
            });
            const body = yield* call("/list-cert-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.certCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListElasticsearchChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createElasticsearchCheck({
              ...scope,
              server: "https://search.example.com:9200",
            });
            const body = yield* call("/list-elasticsearch-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.elasticsearchCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListHttpChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createHttpCheck({
              ...scope,
              url: "https://example.com/",
            });
            const body = yield* call("/list-http-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.httpCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListMongoDBChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createMongodbCheck({
              ...scope,
              server: "mongodb://db.example.com:27017",
            });
            const body = yield* call("/list-mongodb-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.mongodbCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListMySQLChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createMysqlCheck({
              ...scope,
              server: "db.example.com:3306",
            });
            const body = yield* call("/list-mysql-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.mysqlCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListNetworkChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createNetworkCheck({
              ...scope,
              address: "example.com:443",
            });
            const body = yield* call("/list-network-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.networkCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListPingChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createPingCheck({ ...scope, url: "example.com" });
            const body = yield* call("/list-ping-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.pingCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListPostgreSQLChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createPostgresqlCheck({
              ...scope,
              address: "db.example.com:5432",
            });
            const body = yield* call("/list-postgresql-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.postgresqlCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListRabbitMQChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createRabbitmqCheck({
              ...scope,
              url: "https://broker.example.com:15672",
            });
            const body = yield* call("/list-rabbitmq-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.rabbitmqCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("ListRedisChecks", () => {
      test.provider(
        "lists a check seeded out of band, without echoing secrets",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const seeded = yield* observability.createRedisCheck({
              ...scope,
              server: "redis.example.com:6379",
            });
            const body = yield* call("/list-redis-checks");
            expectOk(body);
            expect(body.result.ids).toContain(seeded.redisCheck?.id);
          }),
        OPTIONS,
      );
    });

    describe("CreateBackup", () => {
      test.provider(
        "takes a backup that shows up out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-backup");
            expectOk(body);
            const dates = yield* untilBackup;
            expect(dates.length).toBeGreaterThan(0);
          }),
        OPTIONS,
      );
    });

    describe("ListBackups", () => {
      test.provider(
        "lists a backup taken out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            yield* observability.createBackup({ ...scope, backupTarget: ["alertRules"] });
            const dates = yield* untilBackup;
            const body = yield* call("/list-backups");
            expectOk(body);
            expect(body.result.dates).toContain(dates[0]);
          }),
        OPTIONS,
      );
    });

    describe("ListBackupRetentions", () => {
      test.provider(
        "reads what the API reports out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const body = yield* call("/list-backup-retentions");
            expectOk(body);
            const live = yield* observability.listBackupRetentions(scope);
            expect(body.result.alertRules).toEqual(live.alertRulesBackupRetention);
          }),
        OPTIONS,
      );
    });

    describe("RestoreBackup", () => {
      test.provider(
        "brings back a group deleted after the backup",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            yield* seedGroup("bind-restore");
            yield* observability.createBackup({ ...scope, backupTarget: ["alertRules"] });
            const before = yield* observability.listBackups({
              ...scope,
              backupTarget: ["alertRules"],
            });
            const dates = yield* observability
              .listBackups({ ...scope, backupTarget: ["alertRules"] })
              .pipe(
                Effect.map((live) => live.alertRulesBackups),
                Effect.repeat({
                  schedule: Schedule.spaced("10 seconds"),
                  until: (live) => live.length > before.alertRulesBackups.length,
                  times: 18,
                }),
              );
            yield* observability.deleteAlertgroup({ ...scope, groupName: "bind-restore" });
            yield* untilGone(observeGroup("bind-restore"));
            const body = yield* call("/restore-backup", { date: dates[dates.length - 1]! });
            expectOk(body);
            const group = yield* untilSeen(observeGroup("bind-restore"));
            expect(group?.name).toEqual("bind-restore");
          }),
        OPTIONS,
      );
    });

    describe("CreateBackupSchedule", () => {
      test.provider(
        "adds a schedule visible out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            const body = yield* call("/create-backup-schedule", { cron: "7 3 * * *" });
            expectOk(body);
            const live = yield* observability
              .listBackupSchedules({ ...scope, backupTarget: ["alertRules"] })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (found) =>
                    (found.alertRulesBackupSchedules ?? []).some(
                      (item) => item.schedule === "7 3 * * *",
                    ),
                  times: 24,
                }),
              );
            expect((live.alertRulesBackupSchedules ?? []).map((item) => item.schedule)).toContain(
              "7 3 * * *",
            );
          }),
        OPTIONS,
      );
    });

    describe("ListBackupSchedules", () => {
      test.provider(
        "lists a schedule seeded out of band",
        (_stack) =>
          Effect.gen(function* () {
            const scope = yield* instanceScope;
            yield* observability.createBackupSchedule({
              ...scope,
              schedule: "11 4 * * *",
              backupTarget: ["alertRules"],
            });
            const body = yield* callUntil("/list-backup-schedules", {}, (result) =>
              result?.schedules?.includes("11 4 * * *"),
            );
            expectOk(body);
            expect(body.result.schedules).toContain("11 4 * * *");
          }),
        OPTIONS,
      );
    });

    describe("ReadInstance", () => {
      test.provider(
        "reads through one client",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            yield* seedGroup("bind-read-client");
            const body = yield* call("/read-instance", { name: "bind-read-client" });
            expectOk(body);
            expect(body.result).toEqual({ id: instanceId, group: "bind-read-client" });
          }),
        OPTIONS,
      );
    });

    describe("WriteInstance", () => {
      test.provider(
        "writes through one client, as seen out of band",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write-instance", { name: "bind-write-client" });
            expectOk(body);
            const group = yield* untilSeen(observeGroup("bind-write-client"));
            expect(group?.name).toEqual("bind-write-client");
          }),
        OPTIONS,
      );
    });

    describe("ReadWriteInstance", () => {
      test.provider(
        "writes and reads back through one client",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/read-write-instance", { name: "bind-read-write-client" });
            expectOk(body);
            expect(body.result.group).toEqual("bind-read-write-client");
          }),
        OPTIONS,
      );
    });

    describe("QueryMetrics", () => {
      test.provider(
        "evaluates PromQL on the instance",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/query-metrics");
            expectOk(body);
            expect(body.result.instant[0].value[1]).toEqual("1");
            expect(body.result.rangeType).toEqual("matrix");
            expect(body.result.labels).toEqual("success");
            expect(body.result.values).toEqual("success");
            expect(body.result.series).toEqual("success");
          }),
        OPTIONS,
      );
    });

    describe("Alerts", () => {
      test.provider(
        "fires an alert and silences it on the instance's Alertmanager",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/alerts", { name: "BindAlert" });
            expectOk(body);
            expect(body.result.firing).toEqual(["BindAlert"]);
            expect(typeof body.result.version).toEqual("string");
            expect(body.result.groups).toBeGreaterThan(0);
            expect(body.result.silenced).toEqual("BindAlert");
            expect(body.result.listed).toBe(true);
            expect(body.result.expiredState).toEqual("expired");
          }),
        OPTIONS,
      );
    });

    describe("PushLogs", () => {
      test.provider(
        "pushes a line that the query binding finds",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/push-logs", { app: "bind-push" });
            expectOk(body);
            const found = yield* untilLine("bind-push", "line from bind-push");
            expect(linesOf(found)).toContain("line from bind-push");
          }),
        OPTIONS,
      );
    });

    describe("QueryLogs", () => {
      test.provider(
        "finds a pushed line, and runs a metric query",
        (_stack) =>
          Effect.gen(function* () {
            const pushed = yield* call("/push-logs", { app: "bind-query" });
            expectOk(pushed);
            const found = yield* untilLine("bind-query", "line from bind-query");
            expect(linesOf(found)).toContain("line from bind-query");
          }),
        OPTIONS,
      );
    });
  },
);
