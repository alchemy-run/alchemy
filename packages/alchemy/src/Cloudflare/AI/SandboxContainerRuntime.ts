import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeSandboxLocal } from "../../AI/SandboxLocal.ts";
import * as Dockerfile from "../../Docker/Dockerfile.ts";
import { fixed } from "../../Workspace/Workspace.ts";
import { SandboxContainerImage } from "./SandboxContainer.ts";

/**
 * The sandbox container's IMAGE: the bun base plus the tools an agent's
 * toolbox actually shells out to.
 *
 * - `git` + `ca-certificates` — clones and pushes;
 * - `ripgrep` — the `grep`/`glob` tools run `rg`.
 *
 * Deliberately NOTHING mount-related: bindings carry their own system
 * dependencies into the image (`FUSE.MountTigrisfs`
 * contributes `fuse3` + `tigrisfs` when a mount is bound — see
 * `ContainerImage`). Exported so custom container runtimes can reuse
 * the same toolbox base.
 */
export const SANDBOX_DOCKERFILE = Dockerfile.inline`
  FROM oven/bun:1

  RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep openssh-client \
    && rm -rf /var/lib/apt/lists/*

  WORKDIR /workspace
`;

/**
 * The sandbox container GUEST — the runtime half of
 * {@link SandboxContainerImage} (Container Layer pattern: the class and
 * this `.make()` live in separate files so a Durable Object that
 * imports the class never bundles the guest's process machinery).
 *
 * Inside the container this is just {@link makeSandboxLocal} — the
 * exact physics the trusted-host `SandboxLocal` runs — over a fixed
 * `/workspace` root, served to the Durable Object as typed RPC. The
 * SAME contract, the same code, a different machine.
 *
 * Provide this default export on the Stack program so the image is
 * built and the ContainerApplication deployed.
 */
export default SandboxContainerImage.make(
  {
    main: import.meta.url,
    runtime: "bun",
    dockerfile: SANDBOX_DOCKERFILE,
  },
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
