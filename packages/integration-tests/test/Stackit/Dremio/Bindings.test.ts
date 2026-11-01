import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { slow } from "./dremio.ts";
import DremioBindingsWorker, { Analyst, Lakehouse } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitDremioBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* DremioBindingsWorker;
    const instance = yield* Lakehouse;
    const user = yield* Analyst;
    return {
      url: worker.url.as<string>(),
      instanceId: instance.instanceId,
      uiUrl: instance.endpoints.ui,
      userId: user.userId,
      userName: user.userName,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

/** A cross join of ten billion rows, still running when the cancel arrives. */
const SLOW_QUERY =
  "WITH t AS (SELECT * FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) AS v(x)) " +
  "SELECT COUNT(*) AS c FROM t a, t b, t c, t d, t e, t f, t g, t h, t i, t j";

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// Gated behind STACKIT_TEST_SLOW and STACKIT_TEST_DREMIO, like the suites of the same resources:
// see `dremio.ts` for the cost. No test here has run: no STACKIT credentials exist yet.
describe.skipIf(slow)(
  "STACKIT Dremio bindings on a Cloudflare Worker",
  { tags: [...stackitTags("dremio", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 3_600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a
    // while to propagate: retry until the route answers `ok`, then report the last answer
    // so a real failure shows its error.
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

    /** Submit a statement and return the job's id. */
    const submit = (sql: string) =>
      call("/execute-sql", { sql }).pipe(
        Effect.map((body) => {
          expectOk(body);
          return body.result.id as string;
        }),
      );

    /** Poll a job until it reaches a final state. */
    const finished = (id: string) =>
      call("/get-job", { id }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) => ["COMPLETED", "CANCELED", "FAILED"].includes(body.result?.jobState),
          times: 60,
        }),
      );

    const OPTIONS = { timeout: 240_000 } as const;

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, uiUrl } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toEqual(instanceId);
            expect(body.result.state).toEqual("active");
            expect(body.result.endpoints.ui).toEqual(uiUrl);
          }),
        OPTIONS,
      );
    });

    describe("ListUsers", () => {
      test.provider(
        "lists the deployed user",
        (_stack) =>
          Effect.gen(function* () {
            const { userId } = yield* stack;
            const body = yield* call("/list-users");
            expectOk(body);
            expect(body.result.dremioUsers.map((user: { id: string }) => user.id)).toContain(
              userId,
            );
          }),
        OPTIONS,
      );
    });

    describe("GetUser", () => {
      test.provider(
        "reads the bound user",
        (_stack) =>
          Effect.gen(function* () {
            const { userId, userName } = yield* stack;
            const body = yield* call("/get-user");
            expectOk(body);
            expect(body.result.id).toEqual(userId);
            expect(body.result.name).toEqual(userName);
          }),
        OPTIONS,
      );
    });

    describe("Connect", () => {
      test.provider(
        "resolves the endpoints and logs in, without handing out the secrets",
        (_stack) =>
          Effect.gen(function* () {
            const { uiUrl, userName } = yield* stack;
            const body = yield* call("/connect");
            expectOk(body);
            expect(body.result.uiUrl).toEqual(uiUrl);
            expect(body.result.username).toEqual(userName);
            expect(body.result.catalogUrl.length).toBeGreaterThan(0);
            expect(body.result.arrowFlightUrl.length).toBeGreaterThan(0);
            expect(body.result.hasPassword).toEqual(true);
            expect(body.result.hasToken).toEqual(true);
          }),
        OPTIONS,
      );
    });

    describe("ExecuteSql", () => {
      test.provider(
        "submits a statement that completes",
        (_stack) =>
          Effect.gen(function* () {
            const id = yield* submit("SELECT 1 AS answer");
            const job = yield* finished(id);
            expectOk(job);
            expect(job.result.jobState).toEqual("COMPLETED");
          }),
        OPTIONS,
      );

      test.provider(
        "reports a bad statement on the job, not on the submission",
        (_stack) =>
          Effect.gen(function* () {
            const id = yield* submit("SELECT * FROM alchemy_no_such_source.nothing");
            const job = yield* finished(id);
            expectOk(job);
            expect(job.result.jobState).toEqual("FAILED");
            expect(job.result.errorMessage).toContain("alchemy_no_such_source");
          }),
        OPTIONS,
      );
    });

    describe("GetJob", () => {
      test.provider(
        "types a job that doesn't exist",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-missing-job");
            expectOk(body);
            expect(body.result).toEqual("JobNotFound");
          }),
        OPTIONS,
      );
    });

    describe("GetJobResults", () => {
      test.provider(
        "reads the rows of a completed job",
        (_stack) =>
          Effect.gen(function* () {
            const id = yield* submit("SELECT 1 AS answer");
            yield* finished(id);
            const body = yield* call("/get-job-results", { id });
            expectOk(body);
            expect(body.result.rowCount).toEqual(1);
            expect(body.result.schema[0].name).toEqual("answer");
            expect(body.result.rows).toEqual([{ answer: 1 }]);
          }),
        OPTIONS,
      );

      test.provider(
        "types the results of a job that failed",
        (_stack) =>
          Effect.gen(function* () {
            const id = yield* submit("SELECT * FROM alchemy_no_such_source.nothing");
            yield* finished(id);
            const body = yield* call("/results-not-ready", { id });
            expectOk(body);
            expect(body.result).toEqual("JobResultsNotReady");
          }),
        OPTIONS,
      );
    });

    describe("CancelJob", () => {
      test.provider(
        "cancels a job, which stays readable",
        (_stack) =>
          Effect.gen(function* () {
            const id = yield* submit(SLOW_QUERY);
            const cancelled = yield* call("/cancel-job", { id });
            expectOk(cancelled);
            const job = yield* finished(id);
            expectOk(job);
            expect(job.result.jobState).toEqual("CANCELED");
          }),
        OPTIONS,
      );
    });
  },
);
