import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeSandboxLocal } from "../../AI/SandboxLocal.ts";
import { fixed } from "../../Workspace/Workspace.ts";
import { Role } from "../IAM/Role.ts";
import { MICROVM_BASE_DOCKER_IMAGE } from "../Lambda/MicrovmBundle.ts";
import { SandboxMicrovmImage } from "./SandboxMicrovm.ts";

/**
 * The IAM role Lambda assumes to build the image server-side. Declared
 * here so providing {@link SandboxMicrovmRuntime} on a Stack is
 * self-contained — the MicroVM platform grants it the Assets-bucket
 * and build-log permissions automatically (see `MicrovmImage`).
 */
export const SandboxMicrovmBuildRole = Role("SandboxMicrovmBuildRole");

/**
 * The sandbox MicroVM's image base: the AWS-managed `al2023-minimal`
 * MicroVM base plus the tools an agent's toolbox actually shells out
 * to — the SAME tool set as the Cloudflare `SANDBOX_DOCKERFILE`, on
 * the Firecracker-compatible base (the effectful build appends the
 * bun install and the bundled guest after this).
 *
 * - `git` + `ca-certificates` — clones and pushes;
 * - `ripgrep` — the `grep`/`glob` tools run `rg`.
 */
export const SANDBOX_MICROVM_DOCKERFILE = `
FROM ${MICROVM_BASE_DOCKER_IMAGE}

RUN dnf install -y ca-certificates git ripgrep openssh-clients tar gzip \\
  && dnf clean all \\
  && mkdir -p /workspace
`;

/**
 * The sandbox MicroVM GUEST — the runtime half of
 * {@link SandboxMicrovmImage} (Platform Layer pattern: the class and
 * this `.make()` live in separate files, and this module is the
 * image's own entry — `main: import.meta.url`).
 *
 * Inside the VM this is just {@link makeSandboxLocal} — the exact
 * physics the trusted-host `SandboxLocal` and the Cloudflare container
 * guest run — over a fixed `/workspace` root, served as typed RPC.
 * The SAME contract, the same code, a different machine.
 *
 * Provide it on the Stack program (`AWS.AI.SandboxMicrovmRuntime`) so
 * the image is built (server-side on AWS — the account must be
 * onboarded to the Lambda MicroVM preview and the Assets bucket
 * bootstrapped via `alchemy aws bootstrap`).
 */
export const SandboxMicrovmRuntime = SandboxMicrovmImage.make(
  SandboxMicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.url,
      runtime: "bun" as const,
      dockerfile: SANDBOX_MICROVM_DOCKERFILE,
      buildRole,
      cpuConfigurations: [{ architecture: "ARM_64" as const }],
      resources: [{ minimumMemoryInMiB: 1024 }],
    })),
  ),
  Effect.gen(function* () {
    const sandbox = yield* makeSandboxLocal;
    return {
      exec: sandbox.exec,
      readFile: sandbox.readFile,
      writeFile: sandbox.writeFile,
      deleteFile: sandbox.deleteFile,
      mkdir: sandbox.mkdir,
      listFiles: sandbox.listFiles,
      exists: sandbox.exists,
      // the RPC surface is the product; fetch only answers health checks
      fetch: HttpServerResponse.json({ ok: true }),
    };
  }).pipe(Effect.provide(fixed("/workspace"))),
);

/** The image entry contract: the module default-exports its runtime. */
export default SandboxMicrovmRuntime;
