import { Credentials } from "@distilled.cloud/azure";
import * as web from "@distilled.cloud/azure/web";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, getStableContextDir, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { copyExtraFiles, hashExtraFiles, type ExtraFile } from "alchemy/Util/extraFiles";
import { sha256Object } from "alchemy/Util/sha256";
import { zipFiles } from "alchemy/Util/zip";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export interface AppDeploymentProps {
  /** Resource group of the web app. */
  resourceGroup: string;
  /** Name of an existing App Service web app on a Linux Node.js stack. */
  siteName: string;
  /**
   * Node serve entry (e.g. a framework's `serve-node.mjs`). Alchemy bundles
   * it for Node.js into {@link entry}; start the app with `node <entry>`.
   */
  main: string;
  /**
   * Path of the bundled entry inside the package. Bundled chunks go next to
   * it. Keep the serve entry's original place in the build output when it
   * resolves assets relative to itself.
   * @default "index.mjs"
   */
  entry?: string;
  /** Files copied into the package next to `index.mjs` (e.g. client assets). */
  extraFiles?: ExtraFile[];
  /**
   * npm packages installed on App Service (remote build) instead of
   * bundled, as `{ name: versionRange }`.
   */
  install?: Record<string, string>;
}

export interface AppDeployment extends Resource<
  "Azure.Website.AppDeployment",
  AppDeploymentProps,
  {
    /** Resource group of the web app. */
    resourceGroup: string;
    /** Name of the web app. */
    siteName: string;
    /** `https://{defaultHostName}` of the web app. */
    url: string;
    /** Hash of the deployed package; a new hash triggers a new deployment. */
    codeHash: string;
  },
  never,
  Providers
> {}

/**
 * Zip-deploys a bundled Node.js server to an existing Azure App Service web
 * app through Kudu [OneDeploy](https://learn.microsoft.com/azure/app-service/deploy-zip).
 *
 * Alchemy bundles `main` with rolldown, adds `extraFiles`, and publishes the
 * archive. It deploys again only when the bundle or the extra files change.
 * The web app runs the package with its own Node.js runtime: no Docker
 * image or registry is involved.
 *
 * The package lives and dies with the web app, so deleting this resource
 * does nothing.
 *
 * ### Deploying a Node Server
 * **Example:** Bundle and publish a server to a web app
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("Plan", {
 *   sku: "B1",
 * });
 * const app = yield* Azure.Web.WebApp("App", {
 *   serverFarmId: plan.appServicePlanId,
 *   siteConfig: { linuxFxVersion: "NODE|22-lts", appCommandLine: "node index.mjs" },
 * });
 * yield* Azure.Website.AppDeployment("Code", {
 *   siteName: app.siteName,
 *   main: "dist/server/serve-node.mjs",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const AppDeployment = GroupedResource<AppDeployment>("Azure.Website.AppDeployment");

export class AppDeploymentFailed extends Data.TaggedError("Azure.Website.AppDeploymentFailed")<{
  readonly siteName: string;
  readonly status: number;
  readonly message: string;
}> {}

/** `name.azurewebsites.net` → `name.scm.azurewebsites.net` (also for regional hosts). */
const scmHostOf = (defaultHostName: string) => {
  const [first, ...rest] = defaultHostName.split(".");
  return [first, "scm", ...rest].join(".");
};

const bundleServer = Effect.fn(function* (props: AppDeploymentProps) {
  const realMain = yield* resolveMainPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const bundled = yield* Bundle.build(
    {
      input: realMain,
      cwd,
      platform: "node",
      external: Object.keys(props.install ?? {}),
      resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
    },
    { format: "esm", sourcemap: false, minify: false, entryFileNames: "index.mjs" },
  );
  const packageJson = `${JSON.stringify(
    {
      type: "module",
      private: true,
      scripts: { start: `node ${props.entry ?? "index.mjs"}` },
      ...(props.install !== undefined && Object.keys(props.install).length > 0
        ? { dependencies: props.install }
        : {}),
    },
    null,
    2,
  )}\n`;
  const codeHash = (yield* sha256Object({
    entry: props.entry ?? "index.mjs",
    bundle: bundled.hash,
    extras: yield* hashExtraFiles(props.extraFiles),
    packageJson,
  })).slice(0, 16);
  return { realMain, bundled, packageJson, codeHash };
});

/** Every file under `dir` as zip entries with POSIX paths. */
const readTree = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir, { recursive: true });
  const entries = yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const full = path.join(dir, name);
        if ((yield* fs.stat(full)).type !== "File") return undefined;
        return {
          path: name.split(path.sep).join("/"),
          content: yield* fs.readFile(full),
        };
      }),
    { concurrency: 32 },
  );
  return entries.filter((entry) => entry !== undefined);
});

export const AppDeploymentProvider = () =>
  Provider.succeed(AppDeployment, {
    stables: ["resourceGroup", "siteName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (
        olds !== undefined &&
        (olds.siteName !== news.siteName || olds.resourceGroup !== news.resourceGroup)
      ) {
        return { action: "replace" } as const;
      }
      if (output === undefined) return undefined;
      const { codeHash } = yield* bundleServer(news);
      return codeHash !== output.codeHash ? ({ action: "update" } as const) : undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const { subscriptionId } = yield* AzureEnvironment.current;
      const site = yield* orUndefinedIfNotFound(
        web.GetWebApp({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.siteName,
        }),
      );
      return site === undefined ? undefined : output;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const { dotAlchemy } = yield* AlchemyContext;
      const fs = yield* FileSystem.FileSystem;

      // Observe the web app (it must exist).
      const site = yield* web.GetWebApp({
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        name: news.siteName,
      });
      const defaultHostName = site.properties?.defaultHostName;
      if (defaultHostName === undefined) {
        return yield* new AppDeploymentFailed({
          siteName: news.siteName,
          status: 0,
          message: `web app ${news.siteName} has no defaultHostName`,
        });
      }

      const { realMain, bundled, packageJson, codeHash } = yield* bundleServer(news);
      if (output?.codeHash !== codeHash) {
        yield* session.note(`Packaging ${news.siteName}...`);
        const contextDir = yield* getStableContextDir(realMain, dotAlchemy, `${id}-azure-app`);
        yield* fs.remove(contextDir, { recursive: true }).pipe(Effect.ignore);
        yield* fs.makeDirectory(contextDir, { recursive: true });
        yield* copyExtraFiles(contextDir, news.extraFiles);
        const archive = yield* zipFiles([
          ...(yield* readTree(contextDir)),
          ...bundled.files.map((file, index) => {
            const entry = news.entry ?? "index.mjs";
            const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
            return {
              path: index === 0 ? entry : `${dir}${file.path}`,
              content: file.content,
            };
          }),
          { path: "package.json", content: packageJson },
        ]);

        yield* session.note(`Deploying ${news.siteName}...`);
        const remoteBuild = news.install !== undefined && Object.keys(news.install).length > 0;
        const credentials = yield* yield* Credentials;
        const http = yield* HttpClient.HttpClient;
        const publish = http
          .execute(
            HttpClientRequest.post(
              `https://${scmHostOf(defaultHostName)}/api/publish?type=zip&RemoteBuild=${remoteBuild}&Deployer=alchemy`,
            ).pipe(
              HttpClientRequest.bearerToken(Redacted.value(credentials.bearerToken)),
              HttpClientRequest.bodyUint8Array(new Uint8Array(archive), "application/zip"),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new AppDeploymentFailed({
                  siteName: news.siteName,
                  status: 0,
                  message: String(cause),
                }),
            ),
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : response.text.pipe(
                    Effect.orElseSucceed(() => ""),
                    Effect.flatMap((text) =>
                      Effect.fail(
                        new AppDeploymentFailed({
                          siteName: news.siteName,
                          status: response.status,
                          message: text.slice(0, 500),
                        }),
                      ),
                    ),
                  ),
            ),
          );
        // Kudu answers 409 while a previous deployment (or the site's first
        // start) is still running, and the SCM site can lag a new app by a
        // few seconds.
        yield* publish.pipe(
          Effect.retry({
            while: (error) =>
              error.status === 0 ||
              error.status === 409 ||
              error.status === 404 ||
              error.status >= 500,
            schedule: Schedule.spaced("10 seconds"),
            times: 9,
          }),
        );
      }

      return {
        resourceGroup: news.resourceGroup,
        siteName: news.siteName,
        url: `https://${defaultHostName}`,
        codeHash,
      };
    }),

    delete: () => Effect.void,
  });
