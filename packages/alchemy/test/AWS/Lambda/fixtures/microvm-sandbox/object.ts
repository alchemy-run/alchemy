import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import { MicrovmEgressSandbox } from "./box.ts";
import { MicrovmSandboxGateway, REPO_A, REPO_B } from "./gateway.ts";

export interface Shell {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Owns one MicroVM sandbox, granted GitHub egress through a Cloudflare-hosted gateway. */
export class MicrovmSandboxObject extends Cloudflare.DurableObject<MicrovmSandboxObject>()(
  "MicrovmSandboxObject",
  Effect.gen(function* () {
    const sandbox = yield* MicrovmEgressSandbox;
    const gateway = yield* MicrovmSandboxGateway;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const { fetch } = yield* sandbox.getTcpPort(3000);
      return {
        /** Start (or re-apply to the running MicroVM) with both repositories. */
        start: (size: "small" | "large", ttlMillis: number) =>
          sandbox.start({
            size,
            egress: [
              gateway.repo.narrow({ repository: REPO_A }),
              gateway.repo.narrow({ repository: REPO_B, graphql: false }),
            ],
            ttl: ttlMillis,
          }),
        /** Narrow the running sandbox to REPO_A. */
        narrow: () => sandbox.setEgress({ egress: [gateway.repo.narrow({ repository: REPO_A })] }),
        /** Run a script in the sandbox. */
        sh: (script: string) =>
          fetch(
            HttpClientRequest.post("http://sandbox/sh").pipe(HttpClientRequest.bodyText(script)),
          ).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? response.json
                : response.text.pipe(
                    Effect.flatMap((text) =>
                      Effect.fail(new Error(`sandbox answered ${response.status}: ${text}`)),
                    ),
                  ),
            ),
            Effect.map((body) => body as unknown as Shell),
          ),
        /** `sandbox.exec`: the script through `sh -c`, with `input` on stdin. */
        exec: (script: string, input: string) =>
          Effect.gen(function* () {
            const process = yield* sandbox.exec(["sh", "-c", script], { stdin: "pipe" });
            yield* Stream.make(new TextEncoder().encode(input)).pipe(Stream.run(process.stdin!));
            const output = yield* process.output();
            const decoder = new TextDecoder();
            return {
              pid: process.pid,
              exitCode: output.exitCode,
              stdout: decoder.decode(output.stdout),
              stderr: decoder.decode(output.stderr),
            };
          }).pipe(Effect.scoped),
        running: () => sandbox.running,
        /** What's stored, without the control secret. */
        debug: () =>
          Effect.promise(() =>
            state.raw.storage.get<{
              ttl: number;
              egress: unknown[];
              microvm?: { id: string; size: string; endpoint: string; secret?: string };
            }>("alchemy:egress:MicrovmEgressSandbox"),
          ).pipe(
            Effect.map((stored) => ({
              ttl: stored?.ttl,
              egress: stored?.egress.length,
              microvm: stored?.microvm && { id: stored.microvm.id, size: stored.microvm.size },
            })),
          ),
        stop: () => sandbox.stop(),
      };
    });
  }),
) {}
