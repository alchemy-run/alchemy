/**
 * The alchemy-owned Next.js dev child for AWS (`alchemy dev`) — spawned by
 * `nextjs/aws.ts`'s `dev` as `node [transform-types] aws-dev-entry
 * <configJson>`, replacing the `next dev` CLI child.
 *
 * Runs Next through the documented programmatic custom-server API
 * (`next({ dev: true, dir, hostname, port })` + `prepare()` +
 * `getRequestHandler()`), which is the same `router-server.initialize`
 * the CLI's forked server runs — real Turbopack, recompilation, and error
 * overlay, with THIS process owning the one listener. The HMR websocket
 * upgrade auto-wires through `req.socket.server` on the first
 * Next-handled request; no proxy, no second port.
 *
 * Effectful sites need no front dispatch here (the mount design,
 * Serve/DESIGN.md): the user's route-file mount runs natively inside
 * Next's own pipeline, and Next's compiler hot-reloads the backend module
 * like any other route dependency. Env and credentials are inherited: the
 * sidecar lowered the stack markers + packed binding env into
 * `process.env`, and the mount's `Credentials.fromChain()` resolves the
 * developer's ambient profile — the tested AWS dev credential model.
 *
 * Deliberately plain node (never bun): Node is the AWS Lambda programming
 * model, node's own type transform loads the user's TypeScript backend,
 * and node keys its ESM cache on import query strings (the hot-reload
 * mechanism bun lacks).
 *
 * Known limitation (same as Cloudflare's hmr mode): `next.config` changes
 * do not auto-restart this server — the CLI's parent restart loop is not
 * replicated. Restart `alchemy dev` (or touch the composite's props) to
 * pick up config changes.
 */
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** The argv[2] payload (plain JSON, written by `nextjs/aws.ts`). */
export interface NextjsAwsDevEntryConfig {
  readonly root: string;
  readonly port: number;
  readonly hostname?: string | undefined;
}

type RequestHandler = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => Promise<void>;

/** The subset of `NextCustomServer` (the public custom-server API) we drive. */
interface NextDevApp {
  prepare(): Promise<void>;
  getRequestHandler(): RequestHandler;
  close(): Promise<void>;
}

type CreateNextServer = (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => NextDevApp;

/**
 * Resolve the *project's* `next` (public entry) — the app's installed
 * copy is the one driven, never a hoisted sibling. The entry is CJS;
 * unwrap the ESM-interop `default` nesting to the `createServer`
 * function. (Mirrors `DevServer.ts`'s `loadNext`.)
 */
const loadNext = async (root: string): Promise<CreateNextServer> => {
  const require = createRequire(`${root.replace(/\/+$/, "")}/package.json`);
  const module_ = (await import(
    pathToFileURL(require.resolve("next")).href
  )) as unknown;
  let candidate: unknown = module_;
  for (let i = 0; i < 3 && typeof candidate !== "function"; i++) {
    candidate = (candidate as Record<string, unknown> | undefined)?.default;
  }
  if (typeof candidate !== "function") {
    throw new Error(
      `The "next" package resolved from ${root} has no callable default export`,
    );
  }
  return candidate as CreateNextServer;
};

const main = async (): Promise<void> => {
  const raw = process.argv[2];
  if (raw === undefined) {
    throw new Error("aws-dev-entry: missing the JSON config argument");
  }
  const config = JSON.parse(raw) as NextjsAwsDevEntryConfig;
  // Realpath the project root: a symlinked root (macOS `/var/folders`
  // temp dirs, pnpm layouts) breaks Turbopack's file watching — FSEvents
  // reports realpaths that never match the symlinked `dir`, so edits stop
  // recompiling. (The retired CLI child was immune: `process.cwd()`
  // resolves symlinks.)
  const root = ((): string => {
    try {
      return NodeFs.realpathSync(config.root);
    } catch {
      return config.root;
    }
  })();
  const hostname = config.hostname ?? "localhost";

  // The documented programmatic dev API — the parent resolved the port,
  // so it can seed `next({ port })` (Turbopack derives HMR/asset URLs
  // from it) before anything binds.
  const createNext = await loadNext(root);
  const app = createNext({
    dev: true,
    dir: root,
    hostname,
    port: config.port,
  });
  await app.prepare();
  const nextHandler = app.getRequestHandler();

  // Bind only when fully ready: the parent's readiness poll (any HTTP
  // answer) then observes a server that really serves.
  const server = NodeHttp.createServer((req, res) => {
    void (async () => {
      // The HMR websocket upgrade auto-wires through `req.socket.server`
      // inside Next's handler on the first request it serves.
      await nextHandler(req, res);
    })().catch((error) => {
      console.error("[alchemy] dev request failed:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, hostname, () => resolve());
  });
  console.error(
    `[alchemy] next dev (custom server) ready on http://${hostname}:${config.port}`,
  );

  // Prompt teardown: the serve runtime registers its own SIGTERM drain
  // (closing instance scopes), which suppresses node's default
  // terminate-on-SIGTERM — exit explicitly so the parent's SIGTERM never
  // has to escalate to SIGKILL.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
};

main().catch((error) => {
  console.error("[alchemy] next dev child failed to start:", error);
  process.exit(1);
});
