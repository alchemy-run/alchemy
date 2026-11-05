import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { passMarker } from "@alchemy.run/cloudflare/Domain/Version";
import { expect } from "@alchemy.run/test";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { getWorkerTags } from "../Utils/Worker.ts";
import { call } from "./bench.ts";

/** What the Domain upgrade and move suites read from Cloudflare. */

/** The Durable Object classes Cloudflare hosts for a script, by class name. */
export const namespacesOf = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const namespaces = yield* durableObjects.listNamespaces
    .items({ accountId })
    .pipe(Stream.runCollect);
  return Object.fromEntries(
    namespaces.flatMap((namespace) =>
      namespace.script === scriptName && namespace.class ? [[namespace.class, namespace.id]] : [],
    ),
  );
});

/**
 * Read `path` every 250 ms, without retrying, until interrupted: every answer
 * the Worker gave while a deploy rolled out.
 */
export const watch = (
  url: string,
  path: string,
  answers: Array<{ status: number; body: string }>,
) =>
  HttpClient.execute(
    HttpClientRequest.get(`${url}${path}`).pipe(HttpClientRequest.setHeader("connection", "close")),
  ).pipe(
    Effect.flatMap((res) => Effect.map(res.text, (body) => ({ status: res.status, body }))),
    Effect.catch((error) => Effect.succeed({ status: 0, body: String(error) })),
    Effect.tap((answer) => Effect.sync(() => answers.push(answer))),
    Effect.repeat(Schedule.spaced("250 millis")),
  );

/** How many objects of a namespace Cloudflare lists as holding data. */
export const holdingData = Effect.fn(function* (namespaceId: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const objects = yield* durableObjects.listNamespaceObjects
    .items({ accountId, id: namespaceId })
    .pipe(Stream.runCollect);
  return Array.from(objects).filter((object) => object.hasStoredData === true).length;
});

/** Poll every namespace until `until` holds for its count of objects holding data. */
export const untilListed = (
  namespaceIds: ReadonlyArray<string>,
  until: (count: number) => boolean,
) =>
  Effect.forEach(namespaceIds, (id) =>
    holdingData(id).pipe(
      // Cloudflare lists an object a few minutes after it is written.
      Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until, times: 48 }),
    ),
  );

/** The Worker's migration Workflow, by its binding. */
export const migrationWorkflow = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const settings = yield* workers.getScriptScriptAndVersionSetting({ accountId, scriptName });
  const binding = (settings.bindings ?? []).find(
    (binding) => binding.type === "workflow" && binding.name === "AlchemyDomainMigration",
  );
  expect(binding).toBeDefined();
  return (binding as { readonly workflowName: string }).workflowName;
});

/** How many objects the Worker's migration runs moved, from their complete instances. */
export const movedBy = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const workflowName = yield* migrationWorkflow(scriptName);
  const instances = yield* workflows.listInstances
    .items({ accountId, workflowName, status: "complete" })
    .pipe(Stream.runCollect);
  let moved = 0;
  for (const instance of instances) {
    // Each deploy's run reports how many objects it moved.
    if (!instance.id.startsWith("mg-run-")) continue;
    const { output } = yield* workflows.getInstance({
      accountId,
      workflowName,
      instanceId: instance.id,
    });
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    moved += (parsed as { progress?: { instances?: number } } | null)?.progress?.instances ?? 0;
  }
  return moved;
});

export const tagsOf = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* getWorkerTags(scriptName, accountId);
});

/**
 * Record a complete pass over each class from long ago, as if the move had
 * started earlier: with the passes the deploys ran, the next upload deletes
 * every old class (see `Version.keptMovers`).
 */
export const backdatePasses = Effect.fn(function* (
  scriptName: string,
  classes: ReadonlyArray<string>,
) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const workflowName = yield* migrationWorkflow(scriptName);
  const namespaces = yield* namespacesOf(scriptName);
  for (const className of classes) {
    const instanceId = passMarker(className, namespaces[className]!, 1);
    yield* workflows.createInstance({
      accountId,
      workflowName,
      instanceId,
      params: { op: "mark" },
    });
    yield* workflows.getInstance({ accountId, workflowName, instanceId, simple: true }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (instance) => instance.status === "complete",
        times: 30,
      }),
    );
  }
});

/**
 * Write deposits to `account` one request at a time, from `from` up, and read
 * it between them, until `log.stop` is set: every answer, and the deposits that
 * went through. A deposit is idempotent by its amount, so the count is exact.
 */
export const writer = (
  url: string,
  account: string,
  from: number,
  log: { written: Array<number>; failures: Array<string>; stop: boolean },
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    // Stopped between requests, never during one: a deposit is either counted or not sent.
    for (let amount = from; !log.stop; amount++) {
      const answer = yield* client
        .execute(
          HttpClientRequest.post(`${url}/deposit/${account}/${amount}/1`).pipe(
            HttpClientRequest.setHeader("connection", "close"),
          ),
        )
        .pipe(
          Effect.flatMap((res) => Effect.map(res.text, (body) => ({ status: res.status, body }))),
          Effect.catch((error) => Effect.succeed({ status: 0, body: String(error) })),
        );
      if (answer.status === 200) log.written.push(amount);
      else log.failures.push(`deposit ${amount}: ${answer.status} ${answer.body.slice(0, 200)}`);
      const read = yield* client
        .execute(
          HttpClientRequest.get(`${url}/account/${account}`).pipe(
            HttpClientRequest.setHeader("connection", "close"),
          ),
        )
        .pipe(
          Effect.flatMap((res) => Effect.map(res.text, (body) => ({ status: res.status, body }))),
          Effect.catch((error) => Effect.succeed({ status: 0, body: String(error) })),
        );
      if (read.status !== 200) log.failures.push(`read: ${read.status} ${read.body.slice(0, 200)}`);
    }
  });

/**
 * An account's deposits as its view applied them: their count and total, and
 * which of `expected` are missing.
 */
export const depositsOf = (url: string, key: string, expected?: ReadonlyArray<number>) =>
  call(url, "GET", `/view/${key}`).pipe(
    Effect.map((body) => {
      const amounts = (JSON.parse(body) as { amounts: Array<number> } | null)?.amounts ?? [];
      const seen = new Set(amounts);
      return {
        count: amounts.length,
        total: amounts.reduce((total, amount) => total + amount, 0),
        missing: (expected ?? []).filter((amount) => !seen.has(amount)),
        repeated: amounts.length - seen.size,
      };
    }),
  );

/**
 * The Durable Object classes a Worker binds, by class name, from its own
 * settings. (The account's namespace listing also keeps classes of earlier,
 * deleted Workers with the same name.)
 */
export const boundClasses = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const settings = yield* workers.getScriptScriptAndVersionSetting({ accountId, scriptName });
  const classes: Record<string, string | undefined> = {};
  for (const binding of settings.bindings ?? [])
    if (binding.type === "durable_object_namespace" && "className" in binding && binding.className)
      classes[binding.className] =
        "namespaceId" in binding ? (binding.namespaceId as string | undefined) : undefined;
  return classes;
});
