/**
 * A Docker service that brings an S3 bucket's data to agentOS VMs, the two
 * ways the sandboxes page documents: the service copies objects in and out
 * with its own bindings, or hands a VM a presigned URL it downloads itself.
 */
import * as AWS from "@alchemy.run/aws";
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { SandboxControlPlane, SandboxServices } from "./sandbox-cluster.ts";

export const Data = AWS.S3.Bucket("SandboxData", { forceDestroy: true });

export default class SandboxS3 extends Docker.Service<SandboxS3>()(
  "RivetSandboxS3",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
    };
  }).pipe(Effect.provide(SandboxControlPlane)),
  Effect.gen(function* () {
    const bucket = yield* Data;
    const getObject = yield* AWS.S3.GetObject(bucket);
    const putObject = yield* AWS.S3.PutObject(bucket);
    const presignGetObject = yield* AWS.S3.PresignGetObject(bucket);
    const base = yield* Rivet.SandboxTemplate("S3Agent", {
      // Only S3, for the presigned downloads.
      permissions: {
        network: {
          default: "deny",
          rules: [
            { mode: "allow", patterns: ["dns://**.amazonaws.com", "tcp://**.amazonaws.com:*"] },
          ],
        },
      },
    });
    const sandboxes = yield* Rivet.CreateSandbox(base);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [, step, key] = url.pathname.split("/");
        if (!key) return HttpServerResponse.text("Not Found", { status: 404 });
        const sandbox = sandboxes.getOrCreate(key);
        switch (step) {
          case "copy": {
            // The service copies the object in, the VM works on it, and the
            // service copies the result out.
            yield* putObject({ Key: `${key}/input.txt`, Body: "hello from s3\n" });
            const input = yield* getObject({ Key: `${key}/input.txt` });
            yield* sandbox.files.makeDir("/work");
            yield* sandbox.files.write(
              "/work/input.txt",
              yield* Stream.mkString(Stream.decodeText(input.Body!)),
            );
            yield* sandbox.exec("tr a-z A-Z < input.txt > output.txt", { cwd: "/work" });
            yield* putObject({
              Key: `${key}/output.txt`,
              Body: yield* sandbox.files.readText("/work/output.txt"),
            });
            const output = yield* getObject({ Key: `${key}/output.txt` });
            return yield* HttpServerResponse.json({
              output: yield* Stream.mkString(Stream.decodeText(output.Body!)),
            });
          }
          case "presigned": {
            // The VM downloads the object itself, with no AWS credentials.
            yield* putObject({ Key: `${key}/input.txt`, Body: "fetched by the vm\n" });
            const signed = yield* presignGetObject({ key: `${key}/input.txt`, expiresIn: 300 });
            const result = yield* sandbox.exec([
              "node",
              "-e",
              "fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); require('fs').writeFileSync('/home/agentos/input.txt', await r.text()); }).catch((e) => { console.error(String(e.cause ?? e)); process.exit(1); })",
              signed,
            ]);
            return yield* HttpServerResponse.json({
              result,
              text:
                result.exitCode === 0
                  ? yield* sandbox.files.readText("/home/agentos/input.txt")
                  : undefined,
            });
          }
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SandboxServices,
        AWS.S3.GetObjectHttp,
        AWS.S3.PutObjectHttp,
        AWS.S3.PresignGetObjectHttp,
      ),
    ),
  ),
) {}
