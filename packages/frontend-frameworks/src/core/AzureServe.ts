import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { toOutputFile, type BuildOutput } from "./BuildOutput.ts";
import { DeployTargetError, type DeployTarget } from "./DeployTarget.ts";
import { pinNodeServeModule, type NodeServeEntryOptions } from "./NodeServe.ts";

/**
 * Fetch entry emitted for Azure Functions (`Azure.Website.*` server builds).
 * `Azure.Functions.Function` bundles it as an async handler; no socket is
 * opened.
 */
export const AZURE_SERVE_ENTRY_FILE_NAME = "serve-azure.mjs";

/**
 * Generate a Node 22 Fetch module (`export default { fetch(request) }`) from
 * a framework's portable handler description.
 *
 * Front Door serves the client directory from Blob Storage, so the module
 * carries no static file server: every request it receives goes to the
 * framework handler. Front Door forwards the viewer's host in
 * `X-Forwarded-Host`; the request URL is rewritten to it so absolute URLs
 * the framework builds point at the site, not at the function app.
 */
export const makeAzureServeEntrySource = (options: NodeServeEntryOptions): string => {
  const handler = options.handler;
  return `${handler?.kind === "node" ? 'import { toFetchHandler } from "srvx/node";' : ""}
${handler?.imports ?? ""}
const handle = ${handler === undefined ? "undefined" : handler.kind === "node" ? `toFetchHandler((request, response) => { Promise.resolve((${handler.expr})(request, response)).catch(error => response.destroy(error)); })` : handler.expr};
export default {
  async fetch(request) {
    try {
      const forwarded = request.headers.get("x-forwarded-host");
      if (forwarded && /^[a-zA-Z0-9.\\-]+(?::[0-9]+)?$/.test(forwarded)) {
        const url = new URL(request.url);
        url.host = forwarded;
        url.protocol = "https:";
        request = new Request(url, request);
      }
      if (!handle) return new Response(request.method === "HEAD" ? null : "Not Found", { status: 404 });
      const response = await handle(request);
      if (request.method !== "HEAD" || response.body === null) return response;
      await response.body.cancel();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      console.error("Azure website request failed", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
`;
};

/** Replace a Node target's listening wrapper with the Azure Functions Fetch entry, keeping its framework build. */
export const finishAzureOutput = (output: BuildOutput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entry = output.serverModules?.[0];
    if (entry?.name.endsWith(AZURE_SERVE_ENTRY_FILE_NAME)) return output;
    if (!output.distDirectory || !entry || !output.nodeServe) {
      return yield* new DeployTargetError({
        platform: "azure",
        message: "The framework did not provide a portable Node handler description for Azure.",
      });
    }
    const name = path.join(path.dirname(entry.name), AZURE_SERVE_ENTRY_FILE_NAME);
    let source = makeAzureServeEntrySource(output.nodeServe);
    if (output.nodeServe.handler?.kind === "node") {
      const adapter = yield* Effect.try(() => createRequire(import.meta.url).resolve("srvx/node"));
      const bundle = yield* Effect.tryPromise(() =>
        import("esbuild").then((esbuild) =>
          esbuild.build({
            entryPoints: [adapter],
            bundle: true,
            platform: "node",
            target: "node22",
            format: "esm",
            write: false,
          }),
        ),
      );
      const adapterPath = path.join(
        output.distDirectory,
        path.dirname(name),
        "azure-node-adapter.mjs",
      );
      yield* fs.writeFile(adapterPath, bundle.outputFiles[0]!.contents);
      source = source.replace('from "srvx/node"', 'from "./azure-node-adapter.mjs"');
    }
    yield* fs.writeFileString(path.join(output.distDirectory, name), source);
    const module = yield* toOutputFile(name, source);
    const result = pinNodeServeModule(
      {
        ...output,
        serverModules: output.serverModules?.filter((item) => item.name !== entry.name),
      },
      module,
    );
    yield* fs.remove(path.join(output.distDirectory, entry.name), {
      force: true,
    });
    return result;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DeployTargetError
        ? cause
        : new DeployTargetError({
            platform: "azure",
            message: "Failed to emit the Azure Functions Fetch entry.",
            cause,
          }),
    ),
  );

/**
 * Reuse a framework's Node target (its build and configuration hooks) and
 * emit an Azure Functions Fetch entry instead of a listening server. A
 * framework's `azure.ts` is `makeAzureTarget(makeNodeTarget(config))`.
 */
export const makeAzureTarget = <T extends DeployTarget>(node: T): T => ({
  ...node,
  platform: "azure",
  ...(node.build
    ? {
        build: (context) => node.build!(context).pipe(Effect.flatMap(finishAzureOutput)),
      }
    : {}),
  ...(node.finish
    ? {
        finish: (output, context) =>
          node.finish!(output, context).pipe(Effect.flatMap(finishAzureOutput)),
      }
    : {}),
});
