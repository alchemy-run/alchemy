import * as AWS from "@alchemy.run/aws";
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm, publishedUrl } from "../Docker/Runtime.ts";
import SandboxS3, { Data } from "./fixtures/sandbox-s3.ts";

const testOptions = {
  providers: Layer.mergeAll(Docker.providers(), Rivet.providers(), AWS.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "RivetSandboxS3", import.meta.url);

let url = "";

/** GET a route as JSON; a 500 carries the failure's cause. */
const get = <T>(path: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return (yield* client.get(`${url}${path}`).pipe(Effect.flatMap((res) => res.json))) as T;
  });

const key = () => `vm-${crypto.randomUUID().slice(0, 8)}`;

// agentOS VMs on a local Docker control plane, given an S3 bucket's data by
// the Docker service that holds them.
describe.skipIf(!!process.env.FAST)(
  "Rivet.CreateSandbox with S3",
  { tags: ["provider:rivet", "provider:rivet:sandbox", "provider:aws:s3", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        if (!process.env.NO_DESTROY) yield* stack.destroy();
        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const front = yield* SandboxS3;
            yield* Data;
            return { ports: front.ports };
          }),
        );
        url = publishedUrl(outputs.ports);
        // Wait until a VM answers and the service's AWS key works.
        yield* get(`/copy/${key()}`).pipe(
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 60 }),
        );
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(stack.destroy(), { timeout: 300_000 });

    test(
      "the service copies an object into a VM and the VM's result back to the bucket",
      Effect.gen(function* () {
        expect(yield* get(`/copy/${key()}`)).toEqual({ output: "HELLO FROM S3\n" });
      }),
      { timeout: 120_000 },
    );

    test(
      "a VM downloads an object from a presigned URL the service mints",
      Effect.gen(function* () {
        const { result, text } = yield* get<{
          result: { exitCode: number; stderr: string };
          text?: string;
        }>(`/presigned/${key()}`);
        expect({ exitCode: result.exitCode, stderr: result.stderr, text }).toEqual({
          exitCode: 0,
          stderr: "",
          text: "fetched by the vm\n",
        });
      }),
      { timeout: 120_000 },
    );
  },
);
