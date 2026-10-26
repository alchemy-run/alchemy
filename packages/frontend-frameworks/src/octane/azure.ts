/**
 * `@alchemy.run/frontend-frameworks/octane/azure` — the Azure Functions
 * deploy target for the Octane integration.
 *
 * `Azure.Website.Octane` selects this target. It reuses the Node target's
 * build (Octane's own `vite build` in a child process, auto-listen
 * disabled in `dist/server/entry.js`) and replaces the listening wrapper
 * with `serve-azure.mjs`, a Fetch module (`export default { fetch }`) that
 * `Azure.Functions.Function` bundles. Front Door serves the client
 * directory from Blob Storage, so the module carries no static file server.
 *
 * Octane's `entry.js` reads its SSR template from `index.html` beside
 * itself when it loads. The Function ships only the bundled module, so the
 * finishing pass inlines that template into `entry.js`.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeAzureTarget } from "../core/AzureServe.ts";
import { DeployTargetError, type BuildOutput } from "../core/index.ts";
import { makeNodeTarget, SERVER_ENTRY_FILE_NAME, type OctaneNodeTargetConfig } from "./node.ts";
import type { OctaneTarget } from "./Octane.ts";

/** Octane's SSR template, emitted beside `entry.js`. */
export const TEMPLATE_FILE_NAME = "index.html";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "azure", message, cause });

/** `readFileSync(join(__dirname, "./index.html"), "utf-8")`, minified or not. */
const TEMPLATE_READ =
  /readFileSync\(\s*join\(\s*__dirname\s*,\s*["']\.\/index\.html["']\s*\)\s*,\s*["']utf-?8["']\s*\)/g;

/**
 * Replace Octane's load-time read of `index.html` with the template's
 * contents, so the bundled Function module needs no file beside it.
 */
export const inlineTemplate = (source: string, template: string): string | undefined => {
  const inlined = source.replace(TEMPLATE_READ, () => JSON.stringify(template));
  return inlined === source ? undefined : inlined;
};

const inlineTemplateInOutput = (output: BuildOutput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entry = output.serverModules?.find(
      (module) => path.basename(module.name) === SERVER_ENTRY_FILE_NAME,
    );
    if (output.distDirectory === undefined || entry === undefined) {
      return yield* fail(`The Octane build produced no server ${SERVER_ENTRY_FILE_NAME}`);
    }
    const entryPath = path.join(output.distDirectory, entry.name);
    const templatePath = path.join(path.dirname(entryPath), TEMPLATE_FILE_NAME);
    const source = yield* fs.readFileString(entryPath);
    if (!source.includes(`./${TEMPLATE_FILE_NAME}`)) return output;
    const template = yield* fs.readFileString(templatePath);
    const inlined = inlineTemplate(source, template);
    if (inlined === undefined) {
      return yield* fail(
        `Octane's ${SERVER_ENTRY_FILE_NAME} reads ${TEMPLATE_FILE_NAME} in a form this target does not recognize; the Azure Function would not find the file.`,
      );
    }
    yield* fs.writeFileString(entryPath, inlined);
    return output;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(fail(`Failed to inline ${TEMPLATE_FILE_NAME} into ${SERVER_ENTRY_FILE_NAME}`, cause)),
    ),
  );

/** Octane's production output served by an Azure Functions Fetch handler. */
export const target = (config?: OctaneNodeTargetConfig): OctaneTarget => {
  const azure = makeAzureTarget(makeNodeTarget(config));
  return {
    ...azure,
    ...(azure.build
      ? {
          build: (context) => azure.build!(context).pipe(Effect.flatMap(inlineTemplateInOutput)),
        }
      : {}),
    ...(azure.finish
      ? {
          finish: (output, context) =>
            azure.finish!(output, context).pipe(Effect.flatMap(inlineTemplateInOutput)),
        }
      : {}),
  };
};

export default target;
