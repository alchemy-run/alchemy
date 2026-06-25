import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { CodingAgentService } from "../../AI/CodingAgent.ts";
import { CodingAgentRuntime } from "../../AI/CodingAgentRuntime.ts";
import { Container } from "../Container/Container.ts";

/** Where the agent checks out and works on each repository inside the container. */
export const WORKSPACE = "/workspace";

/**
 * Default provider/model the in-container agent uses when a {@link
 * CodingAgent.send} message does not specify one. Override per container via
 * {@link CodingAgentContainerOptions.model} or per turn via the message.
 */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/**
 * Default container image: a Debian-based Bun image with the CLI tools a
 * coding-agent runtime typically relies on (git, ripgrep, node, curl). Most
 * harnesses bootstrap their own runtime on top of this; override via
 * {@link CodingAgentContainerOptions.dockerfile} when a runtime needs more.
 */
export const DEFAULT_DOCKERFILE = `
  FROM oven/bun:1.3
  RUN apt-get update \\
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl nodejs npm \\
    && rm -rf /var/lib/apt/lists/*
  WORKDIR ${WORKSPACE}
`;

/**
 * A long-lived Linux container that hosts a {@link CodingAgent}: it runs the
 * persistent agent actor (mailbox, event pub/sub, interrupt) on top of a
 * coding-agent runtime (a third-party harness such as OpenCode, or a native
 * implementation) against a checked-out repository.
 *
 * Its RPC shape **is** the `alchemy/AI` {@link CodingAgent} interface, member
 * for member, so the agent looks identical in-process, in this container, and
 * behind a Durable Object — each layer just forwards the calls. The container is
 * where the workspace filesystem and the runtime live, so the actor itself runs
 * here; a `CodingAgent` Durable Object is a thin durable wrapper that delegates
 * to this container.
 *
 * This is only the **tag** — the name plus the typed RPC shape, which **is**
 * the shared {@link CodingAgentService} interface (member for member, including
 * the streaming {@link CodingAgentService.events}). The runtime is built with
 * {@link makeCodingAgentContainer}, which is harness-agnostic: it hosts a
 * {@link CodingAgentRuntime} (built by a harness package such as
 * `@alchemy.run/harness-opencode`) and forwards its interface over RPC.
 */
export class CodingAgentContainer extends Container<
  CodingAgentContainer,
  CodingAgentService
>()("CodingAgentContainer") {}

/** Options for {@link makeCodingAgentContainer}. */
export interface CodingAgentContainerOptions<RIn> {
  /**
   * The container's bundled entrypoint — pass `import.meta.filename` from the
   * module that calls this (the file the bundler bakes into the image).
   */
  readonly main: string;
  /**
   * Factory for the {@link CodingAgentRuntime} the container hosts, given the
   * resolved `workspace` + `model` the container owns. Its requirements `RIn`
   * (e.g. `ChildProcessSpawner` / `FileSystem`) are satisfied by the container
   * platform at runtime. A harness package wraps its own runtime layer here.
   */
  readonly runtime: (config: {
    readonly workspace: string;
    readonly model: string;
  }) => Layer.Layer<CodingAgentRuntime, never, RIn>;
  /**
   * Default provider/model identifier the agent uses when a `send` message omits
   * one. @default {@link DEFAULT_MODEL}
   */
  readonly model?: string;
  /**
   * Absolute path to the workspace the agent operates on inside the container.
   * @default {@link WORKSPACE}
   */
  readonly workspace?: string;
  /** Override the container image. @default {@link DEFAULT_DOCKERFILE} */
  readonly dockerfile?: string;
  /**
   * Module specifiers to keep out of the bundle and install into the image
   * instead (via `bun add`). Required for harness packages that read on-disk
   * runtime assets relative to `import.meta.url` (e.g. OpenCode's bridge files
   * under `dist/bridge/`), which bundling would otherwise strip.
   */
  readonly external?: string[];
}

/**
 * Build the runtime `Layer` for a {@link CodingAgentContainer} from a
 * {@link CodingAgentRuntime} factory. The body is harness-agnostic: it builds
 * the runtime with the container's `workspace` + `model` (the container platform
 * satisfies the runtime's `FileSystem` / `ChildProcessSpawner`) and forwards its
 * {@link CodingAgentService} interface over the container RPC, plus a `/health`
 * route. A harness package calls this with `import.meta.filename` and its own
 * runtime factory.
 *
 * @example
 * ```ts
 * // @alchemy.run/harness-opencode/OpenCodeContainer.ts
 * export default makeCodingAgentContainer({
 *   main: import.meta.filename,
 *   runtime: (config) => OpenCodeAgent({ ...config, anthropic }),
 * });
 * ```
 */
export const makeCodingAgentContainer = <RIn>(
  options: CodingAgentContainerOptions<RIn>,
) =>
  CodingAgentContainer.make(
    {
      main: options.main,
      dockerfile: options.dockerfile ?? DEFAULT_DOCKERFILE,
      external: options.external,
      observability: { logs: { enabled: true } },
    },
    Effect.gen(function* () {
      const agent = yield* CodingAgentRuntime;

      return CodingAgentContainer.of({
        send: (input) => agent.send(input),
        interrupt: () => agent.interrupt(),
        events: () => agent.events(),
        poll: (cursor) => agent.poll(cursor),
        readFile: (path) => agent.readFile(path),
        listFiles: (path) => agent.listFiles(path),

        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const url = new URL(request.url, "http://coding-agent");
          if (url.pathname === "/health") {
            return yield* HttpServerResponse.json({ ok: true });
          }
          return HttpServerResponse.text("coding agent");
        }),
      });
    }).pipe(
      Effect.provide(
        options.runtime({
          workspace: options.workspace ?? WORKSPACE,
          model: options.model ?? DEFAULT_MODEL,
        }),
      ),
    ),
  );
