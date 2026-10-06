import {
  getDeployment,
  getEnvironmentVariables,
  getService,
} from "@distilled.cloud/prisma/management";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { createComputeArchive } from "@/Prisma/ComputeArchive";
import { isActionState, State } from "@/State/State.ts";
import type * as Test from "@/Test/Alchemy";
import { expectGone } from "./Live.ts";

/**
 * A Bun server for live Compute deploys. `/` answers `GREETING`, `/env?key=K`
 * answers the runtime value of `K`, and `/health` answers 200.
 */
const SERVER_SOURCE = [
  'const port = Number(process.env["PORT"] ?? "8080");',
  "Bun.serve({",
  "  port,",
  "  fetch(request) {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return Response.json({ ok: true });',
  '    if (url.pathname === "/env") {',
  '      return new Response(process.env[url.searchParams.get("key") ?? ""] ?? "missing");',
  "    }",
  '    return new Response(process.env["GREETING"] ?? "missing");',
  "  },",
  "});",
  "export {};",
  "",
].join("\n");

/** Write the live server into a scoped temp directory; returns the directory. */
export const writeServerApp = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module", main: "server.ts" }),
    );
    yield* fs.writeFileString(path.join(directory, "server.ts"), SERVER_SOURCE);
    return directory;
  });

/** Archive the live server into a pre-built `tar.gz`; returns the file path. */
export const writeServerArtifact = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* writeServerApp(prefix);
    const bytes = yield* createComputeArchive({ directory, entrypoint: "server.ts" });
    const output = yield* fs.makeTempDirectoryScoped({ prefix: `${prefix}artifact-` });
    const artifactPath = path.join(output, "app.tar.gz");
    yield* fs.writeFile(artifactPath, bytes);
    return artifactPath;
  });

class NotServing extends Data.TaggedError("NotServing")<{
  url: string;
  status: number;
  body: string;
}> {}

/**
 * GET `url` until it answers 200 with `expected`. Fresh deployments and
 * promotions take a few seconds to reach the edge.
 */
export const expectServes = (url: string, expected: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.flatMap((body) =>
          response.status === 200 && body === expected
            ? Effect.succeed(body)
            : Effect.fail(new NotServing({ url, status: response.status, body })),
        ),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
  );

/** Sorted keys of the variables in one environment scope. */
export const environmentKeys = (
  projectId: string,
  cls: "production" | "preview",
  branchId: string | null = null,
) =>
  getEnvironmentVariables({
    projectId,
    class: cls,
    limit: 100,
    ...(branchId === null ? {} : { branchId }),
  }).pipe(
    Effect.map((response) =>
      response.data
        .filter((variable) => variable.branchId === branchId)
        .map((variable) => variable.key)
        .sort(),
    ),
  );

export const expectServiceGone = (serviceId: string) =>
  expectGone(
    getService({ serviceId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const expectDeploymentGone = (deploymentId: string) =>
  expectGone(
    getDeployment({ deploymentId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

/** Read a resource's persisted state row, to put back with `restoreState`. */
export const snapshotState = (stack: Test.ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stored = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
    if (!stored || isActionState(stored)) {
      return yield* Effect.die(new Error(`Expected a resource state row for '${fqn}'`));
    }
    return stored;
  }).pipe(Effect.provide(stack.state));

export const restoreState = (
  stack: Test.ScratchStack,
  fqn: string,
  value: Effect.Success<ReturnType<typeof snapshotState>>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.set({ stack: stack.name, stage: stack.stage, fqn, value });
  }).pipe(Effect.provide(stack.state));
