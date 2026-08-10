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
 * - `ripgrep` — the `grep`/`glob` tools run `rg`;
 * - `fuse3` + `tigrisfs` — the FUSE adapter `Cloudflare.R2.FuseMount`
 *   uses to mount an R2 bucket as a filesystem, so state can outlive
 *   this (ephemeral) container.
 *
 * `tigrisfs` ships prebuilt release tarballs, so it costs one layer
 * rather than a Go toolchain.
 */
const SANDBOX_DOCKERFILE = Dockerfile.inline`
  FROM oven/bun:1

  # NOTE: the tigrisfs version is inlined LITERALLY (bump it here). The
  # template must not interpolate: \`Dockerfile.inline\` turns any
  # interpolation into an \`Output\`, which the image build cannot read.
  # Shell vars use \`$ARCH\` (no braces) for the same reason.
  RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep fuse3 openssh-client \
    && ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v1.2.1/tigrisfs_1.2.1_linux_$ARCH.deb" \
      -o /tmp/tigrisfs.deb \
    && dpkg -i /tmp/tigrisfs.deb \
    && rm /tmp/tigrisfs.deb \
    && echo "user_allow_other" >> /etc/fuse.conf \
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
