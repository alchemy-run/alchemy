import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  isScriptNotFound,
  isWorkersDevNotFound,
} from "./WorkerDeploymentResponse.ts";
import LifecycleWorker, {
  type Scenario,
} from "./fixtures/workflow-lifecycle/worker.ts";

const Stack = Alchemy.Stack(
  "WorkflowLifecycleStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* LifecycleWorker;
    return { url: worker.url.as<string>() };
  }),
);

interface Status {
  status: string;
  output?: string[];
  error?: unknown;
  rollback?: { outcome: string } | null;
  entries: string[];
}

class WorkflowWorkerNotReady extends Data.TaggedError(
  "WorkflowWorkerNotReady",
)<{
  url: string;
  status: number;
  body: string;
  ray: string | undefined;
}> {}

const request = Effect.fn(
  function* (url: string, method: "GET" | "POST" = "GET") {
    const client = yield* HttpClient.HttpClient;
    const response = yield* method === "GET"
      ? client.get(url)
      : client.post(url);
    const body = yield* response.text;
    if (
      isWorkersDevNotFound(response, body, url) ||
      isScriptNotFound(response, body, url) ||
      (method === "GET" &&
        new URL(url).pathname === "/ready" &&
        response.status === 200 &&
        body !== "ready")
    ) {
      yield* Effect.logInfo("Workflow Worker is not ready", {
        url,
        method,
        status: response.status,
        server: response.headers.server,
        contentType: response.headers["content-type"],
        ray: response.headers["cf-ray"],
      });
      return yield* Effect.fail(
        new WorkflowWorkerNotReady({
          url,
          status: response.status,
          body,
          ray: response.headers["cf-ray"],
        }),
      );
    }
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(
          `${method} ${url}: HTTP ${response.status}; server=${response.headers.server}; content-type=${response.headers["content-type"]}; cf-ray=${response.headers["cf-ray"]}: ${body}`,
        ),
      );
    }
    return body;
  },
  Effect.timeout("5 seconds"),
  Effect.retry({
    while: (error) => error instanceof WorkflowWorkerNotReady,
    schedule: Schedule.spaced("1 second"),
    times: 8,
  }),
);

describe("workflow response classification", () => {
  const url = "https://workflow.testing.workers.dev/start/success";
  const body = `<!DOCTYPE html>
<meta http-equiv="refresh" content="30">
<title>Page not found</title>
<link rel="icon" href="https://workers.cloudflare.com/favicon.ico">
<h1>There is nothing here yet</h1>
<p>If you expect something to be here, it may take some time.<br/>Please check back again later.</p>`;
  const headers = {
    server: "cloudflare",
    "content-type": "text/html; charset=UTF-8",
    "cf-ray": "a3d1ff6739c3fef7-SEA",
  };

  it.live("retries the native placeholder before starting one workflow", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let starts = 0;
      const client = HttpClient.make((httpRequest) =>
        Effect.sync(() => {
          expect(httpRequest.method).toBe("POST");
          attempts++;
          if (attempts === 1) {
            return HttpClientResponse.fromWeb(
              httpRequest,
              new Response(body, { status: 404, headers }),
            );
          }
          starts++;
          return HttpClientResponse.fromWeb(
            httpRequest,
            Response.json({ id: "one-workflow" }),
          );
        }),
      );
      const result = yield* request(url, "POST").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(JSON.parse(result)).toEqual({ id: "one-workflow" });
      expect(attempts).toBe(2);
      expect(starts).toBe(1);
    }),
  );

  const rejected: Array<{
    name: string;
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    url?: string;
  }> = [
    { name: "application text 404", body: "Not Found" },
    { name: "application JSON 404", body: '{"error":"Not Found"}' },
    {
      name: "application HTML 404",
      body: "<title>Page not found</title><h1>Not Found</h1>",
    },
    { name: "application 500", status: 500, body: "Internal Server Error" },
    { name: "wrong status", status: 500 },
    {
      name: "wrong content type",
      headers: { ...headers, "content-type": "application/json" },
    },
    { name: "missing server", headers: { ...headers, server: "" } },
    { name: "missing Ray ID", headers: { ...headers, "cf-ray": "" } },
    { name: "invalid Ray ID", headers: { ...headers, "cf-ray": "not-a-ray" } },
    { name: "custom domain", url: "https://example.com/start/success" },
    {
      name: "local HTTP target",
      url: "http://workflow.testing.workers.dev/start/success",
    },
    {
      name: "incomplete page",
      body: body.replace(
        'href="https://workers.cloudflare.com/favicon.ico"',
        'href="/favicon.ico"',
      ),
    },
  ];
  for (const response of rejected) {
    it.live(`does not replay a workflow start after ${response.name}`, () =>
      Effect.gen(function* () {
        let attempts = 0;
        const client = HttpClient.make((httpRequest) =>
          Effect.sync(() => {
            attempts++;
            return HttpClientResponse.fromWeb(
              httpRequest,
              new Response(response.body ?? body, {
                status: response.status ?? 404,
                headers: response.headers ?? headers,
              }),
            );
          }),
        );
        const error = yield* request(response.url ?? url, "POST").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip,
        );
        expect(error).not.toBeInstanceOf(WorkflowWorkerNotReady);
        expect(attempts).toBe(1);
      }),
    );
  }

  it.live(
    "requires the fixture readiness body rather than a precreate 200",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        const client = HttpClient.make((httpRequest) =>
          Effect.sync(() => {
            expect(httpRequest.method).toBe("GET");
            attempts++;
            return HttpClientResponse.fromWeb(
              httpRequest,
              new Response(
                attempts === 1
                  ? "Alchemy worker is being deployed..."
                  : "ready",
              ),
            );
          }),
        );
        const result = yield* request(
          "https://workflow.testing.workers.dev/ready",
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(result).toBe("ready");
        expect(attempts).toBe(2);
      }),
  );

  it.live("bounds repeated native placeholder responses", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = HttpClient.make((httpRequest) =>
        Effect.sync(() => {
          attempts++;
          return HttpClientResponse.fromWeb(
            httpRequest,
            new Response(body, { status: 404, headers }),
          );
        }),
      );
      const error = yield* request(url, "POST").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(WorkflowWorkerNotReady);
      expect(attempts).toBe(9);
    }),
  );
});

const cases: Array<{ scenario: Scenario; entries: string[] }> = [
  {
    scenario: "success",
    entries: ["open:1:captured:true", "close:1", "after-task"],
  },
  {
    scenario: "retry",
    entries: [
      "open:1:captured:true",
      "close:1",
      "open:2:captured:true",
      "close:2",
      "after-task",
    ],
  },
  {
    scenario: "interrupt",
    entries: ["open:1:captured:true", "close:1", "joined", "after-task"],
  },
  {
    scenario: "rollback",
    entries: [
      "open:1:captured:true",
      "close:1",
      "after-task",
      "rollback-open:captured:true",
      "rollback-body",
      "rollback-close",
    ],
  },
];

describe.concurrent.each([
  { dev: true, stage: "workflow-lifecycle-local" },
  { dev: false, stage: "workflow-lifecycle-live" },
])("Workflow lifecycle (dev: $dev)", ({ dev, stage }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    dev,
    stage,
  });
  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      yield* request(`${output.url}/ready`);
      return output;
    }),
    { timeout: 120_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 30_000,
  });

  for (const { scenario, entries } of cases) {
    test(
      `closes and owns ${scenario} attempt resources`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const started = yield* request(`${url}/start/${scenario}`, "POST");
        const { id } = yield* Effect.try(
          () => JSON.parse(started) as { id: string },
        );
        const status = yield* request(`${url}/status/${id}`).pipe(
          Effect.flatMap((body) =>
            Effect.try(() => JSON.parse(body) as Status),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
            until: (status) =>
              (status.status === "complete" || status.status === "errored") &&
              (scenario !== "rollback" ||
                (status.entries.includes("rollback-body") &&
                  status.entries.includes("rollback-close"))),
          }),
        );
        expect(status, JSON.stringify(status)).toMatchObject({
          status: scenario === "rollback" ? "errored" : "complete",
          entries,
        });
        if (scenario !== "rollback") expect(status.output).toEqual(entries);
      }),
      { timeout: 60_000 },
    );
  }
});
