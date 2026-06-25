import * as workers from "@distilled.cloud/cloudflare/workers";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Artifacts from "../../Artifacts.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as Provider from "../../Provider.ts";
import { type ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { CloudflareLogs } from "../Logs.ts";
import { readAssets, uploadAssets } from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { isDurableObjectExport } from "./DurableObjectNamespace.ts";
import { LocalWorkerProvider } from "./LocalWorkerProvider.ts";
import { Worker, type WorkerProps } from "./Worker.ts";
import { getCronBindings } from "./WorkerAsyncBindings.ts";
import type { WorkerBinding, WorkerSettingsBinding } from "./WorkerBinding.ts";
import { readPrebuiltWorkerBundle, WorkerBundle } from "./WorkerBundle.ts";
import { isWorkerLoader } from "./WorkerLoader.ts";
import { createWorkerName } from "./WorkerName.ts";
class MissingDurableObjectNamespaces extends Data.TaggedError(
  "MissingDurableObjectNamespaces",
)<{
  scriptName: string;
  expected: string[];
}> {}

export const WorkerProvider = () =>
  ProviderLayer.select({
    live: () => LiveWorkerProvider(),
    local: () => LocalWorkerProvider(),
  });

export const LiveWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const bundler = yield* WorkerBundle;
      const stack = yield* Stack;

      // const createScriptSubdomain = yield* workers.createScriptSubdomain;
      // const deleteScript = yield* workers.deleteScript;
      // const getScriptSubdomain = yield* workers.getScriptSubdomain;
      // const getScriptSchedule = yield* workers.getScriptSchedule;
      // const getScriptSettings = yield* workers.getScriptScriptAndVersionSetting;
      // const getSubdomain = yield* workers.getSubdomain;
      // const putScript = yield* workers.putScript;
      // const putScriptSchedule = yield* workers.putScriptSchedule;
      // const putDomain = yield* workers.putDomain;
      // const listDomains = yield* workers.listDomains;
      // const deleteDomain = yield* workers.deleteDomain;
      // const listZones = yield* zones.listZones;
      const telemetry = yield* CloudflareLogs;

      const getAccountSubdomain = (accountId: string) =>
        workers
          .getSubdomain({
            accountId,
          })
          .pipe(Effect.map((result) => result.subdomain));

      // Toggle the workers.dev subdomain via `POST /subdomain` with
      // `enabled: true | false`. Mirrors the upstream Alchemy
      // implementation in `.vendor/alchemy/.../worker-subdomain.ts`.
      // When enabling we also set `previewsEnabled: true` so the
      // script is reachable both at its stable workers.dev URL and at
      // version-preview URLs; on disable we send just `enabled: false`.
      const setWorkerSubdomain = Effect.fn(function* (
        name: string,
        enabled: boolean,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* workers.createScriptSubdomain({
          accountId,
          scriptName: name,
          enabled,
          previewsEnabled: enabled ? true : undefined,
        });
      });

      // Convert non-ASCII hostnames (emoji, IDN, etc.) to punycode so the
      // Cloudflare API receives the form it stores domains in. `new URL(...)`
      // does IDNA via WHATWG URL parsing — `📦.alchemy.run` → `xn--5z8h.alchemy.run`.
      const toPunycode = (hostname: string): string => {
        try {
          return new URL(`https://${hostname}`).hostname;
        } catch {
          return hostname;
        }
      };

      const normalizeDomains = (
        domain: string | string[] | undefined,
      ): string[] =>
        domain === undefined
          ? []
          : Array.from(
              new Set(
                (Array.isArray(domain) ? domain : [domain]).map(toPunycode),
              ),
            );

      const normalizeCrons = (crons: string[] | undefined): string[] =>
        Array.from(new Set(crons ?? []));

      const getWorkerCrons = Effect.fn(function* (scriptName: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* workers
          .getScriptSchedule({
            accountId,
            scriptName,
          })
          .pipe(
            Effect.map((response) =>
              normalizeCrons(
                response.schedules.map((schedule) => schedule.cron),
              ),
            ),
            Effect.catchTag("WorkerNotFound", () => Effect.succeed([])),
          );
      });

      const reconcileCrons = (
        scriptName: string,
        desired: string[],
        previous: string[],
        session: ScopedPlanStatusSession,
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const live = yield* getWorkerCrons(scriptName);
          const desiredSorted = [...desired].sort();
          const liveSorted = [...live].sort();
          const changed =
            desiredSorted.length !== liveSorted.length ||
            desiredSorted.some((cron, index) => cron !== liveSorted[index]);

          if (!changed) return live;

          if (desired.length > 0 || previous.length > 0 || live.length > 0) {
            yield* session.note(
              `Reconciling Cron Triggers (${desired.length}) ...`,
            );
          }

          const result = yield* workers
            .putScriptSchedule({
              accountId,
              scriptName,
              body: desired.map((cron) => ({ cron })),
            })
            .pipe(
              Effect.retry({
                while: (error) => error._tag === "WorkerNotFound",
                schedule: Schedule.exponential(200).pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );
          return normalizeCrons(
            result.schedules.map((schedule) => schedule.cron),
          );
        });

      /**
       * Infer the Cloudflare Zone ID for a given hostname by listing the
       * account's zones and matching the hostname against each zone's name —
       * walking up the DNS label hierarchy until a match is found.
       */
      const inferZoneIdForHostname = (
        hostname: string,
        zoneCache: Map<string, string>,
      ) =>
        Effect.gen(function* () {
          const cached = zoneCache.get(hostname);
          if (cached) return cached;

          const zoneList = yield* zones
            .listZones({})
            .pipe(Effect.map((response) => response.result ?? []));
          for (const zone of zoneList) {
            zoneCache.set(zone.name, zone.id);
          }

          const parts = hostname.split(".");
          for (let i = 0; i < parts.length - 1; i++) {
            const candidate = parts.slice(i).join(".");
            const match = zoneList.find((z) => z.name === candidate);
            if (match) {
              zoneCache.set(hostname, match.id);
              return match.id;
            }
          }
          return yield* Effect.die(
            `Could not infer Cloudflare Zone for hostname "${hostname}". ` +
              "Ensure the parent zone exists in this account.",
          );
        });

      const reconcileDomains = (scriptName: string, desired: string[]) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          // Always query the live state of domains attached to *this*
          // Worker rather than trusting `_previous` from local state.
          // State may have been wiped, populated by another machine, or
          // simply be out of date. Without this we PUT domains that are
          // already registered to this same Worker and Cloudflare
          // returns a confusing "hostname already in use" error.
          const liveAll = yield* workers
            .listDomains({
              accountId,
              service: scriptName,
            })
            .pipe(
              Effect.map((r) =>
                (r.result ?? []).flatMap((d) =>
                  d.id && d.hostname && d.zoneId
                    ? [
                        {
                          id: d.id,
                          hostname: d.hostname,
                          zoneId: d.zoneId,
                          service: d.service ?? undefined,
                        },
                      ]
                    : [],
                ),
              ),
              Effect.catch(() => Effect.succeed([])),
            );

          const desiredSet = new Set(desired);
          const liveByHostname = new Map(liveAll.map((d) => [d.hostname, d]));

          // Detach what's no longer wanted. Use the live list so we
          // don't try to delete domains we no longer track.
          const toRemove = liveAll.filter((d) => !desiredSet.has(d.hostname));
          yield* Effect.all(
            toRemove.map((d) =>
              workers
                .deleteDomain({ accountId, domainId: d.id })
                .pipe(Effect.catchTag("DomainNotFound", () => Effect.void)),
            ),
            { concurrency: "unbounded" },
          );

          if (desired.length === 0) return [];

          const zoneCache = new Map<string, string>();

          // Attach `hostname` to this Worker. Skip the PUT entirely if
          // the hostname is already attached to *this* Worker — that's a
          // no-op for Cloudflare and avoids the "already in use" 409.
          // If it's attached to a *different* Worker, refuse with a
          // clear message rather than silently re-routing traffic.
          const attachDomain = Effect.fn(function* (hostname: string) {
            const live = liveByHostname.get(hostname);
            if (live) {
              return {
                hostname: live.hostname,
                id: live.id,
                zoneId: live.zoneId,
              };
            }

            // Not attached to this Worker — but it could still belong
            // to another Worker. Check before we try to PUT so we can
            // emit a helpful error instead of the raw 409.
            const otherOwner = yield* workers
              .listDomains({
                accountId,
                hostname,
              })
              .pipe(
                Effect.map((r) =>
                  (r.result ?? []).find(
                    (d) => d.hostname === hostname && d.service !== scriptName,
                  ),
                ),
                Effect.catch(() => Effect.succeed(undefined)),
              );
            if (otherOwner?.id) {
              return yield* Effect.die(
                new Error(
                  `Cannot attach hostname '${hostname}' to Worker '${scriptName}': ` +
                    `it is already attached to Worker '${otherOwner.service ?? "<unknown>"}'. ` +
                    `Detach it from that Worker first, or pick a different hostname.`,
                ),
              );
            }

            const zoneId = yield* inferZoneIdForHostname(hostname, zoneCache);
            // Same eventual-consistency window as `setWorkerSubdomain`:
            // PUT /accounts/.../workers/domains right after `putScript`
            // can return `WorkerNotFound` until Cloudflare's script
            // registry has propagated. Retry on that specific tag.
            const res = yield* workers
              .putDomain({
                accountId,
                hostname,
                service: scriptName,
                zoneId,
              })
              .pipe(
                Effect.retry({
                  while: (error) => error._tag === "WorkerNotFound",
                  schedule: Schedule.exponential(200).pipe(
                    Schedule.both(Schedule.recurs(15)),
                  ),
                }),
              );
            return {
              hostname,
              id: res.id ?? "",
              zoneId: res.zoneId ?? zoneId,
            };
          });

          const applied = yield* Effect.all(desired.map(attachDomain), {
            concurrency: "unbounded",
          });
          return applied;
        });

      const createAlchemyWorkerTags = (id: string) => [
        `alchemy:stack:${stack.name}`,
        `alchemy:stage:${stack.stage}`,
        `alchemy:id:${id}`,
      ];

      const hasAlchemyWorkerTags = (
        id: string,
        tags: readonly string[] | undefined,
      ) => {
        const actualTags = new Set(tags ?? []);
        return createAlchemyWorkerTags(id).every((tag) => actualTags.has(tag));
      };

      const getDurableObjectNamespaces = (
        bindings: readonly WorkerSettingsBinding[] | null | undefined,
      ) => {
        const namespaces = Object.fromEntries(
          (bindings ?? []).flatMap((binding) =>
            binding.type === "durable_object_namespace" &&
            binding.className &&
            binding.namespaceId
              ? [[binding.className, binding.namespaceId]]
              : [],
          ),
        );
        return namespaces;
      };

      const getExpectedDurableObjectClassNames = (
        bindings: readonly WorkerBinding[] | undefined,
        workerName: string,
      ) =>
        Array.from(
          new Set(
            bindings?.flatMap((binding) =>
              binding.type === "durable_object_namespace" &&
              binding.className &&
              (binding.scriptName === undefined ||
                binding.scriptName === workerName)
                ? [binding.className]
                : [],
            ) ?? [],
          ),
        );

      const getWorkerSettingsWithDurableObjects = Effect.fn(function* (
        scriptName: string,
        expectedClassNames: readonly string[],
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* workers
          .getScriptScriptAndVersionSetting({
            accountId,
            scriptName,
          })
          .pipe(
            Effect.map((settings) => {
              const namespaces = getDurableObjectNamespaces(settings.bindings);
              const missing = expectedClassNames.filter(
                (className) => !namespaces[className],
              );
              if (missing.length > 0) {
                return Effect.fail(
                  new MissingDurableObjectNamespaces({
                    scriptName,
                    expected: missing,
                  }),
                );
              }
              return Effect.succeed({
                settings,
                durableObjectNamespaces: namespaces,
              });
            }),
            Effect.flatten,
            Effect.retry({
              // `MissingDurableObjectNamespaces`: the DO bindings haven't
              // surfaced in the version settings yet. `WorkerHasNoVersions` /
              // `WorkerNotFound`: right after the first `putScript`, the
              // version-settings read can race the script registry — under a
              // busy account this read can briefly 404 with "has no versions"
              // (or the worker itself as not-yet-found) before the upload
              // propagates. All three are eventual-consistency blips.
              while: (error) =>
                error._tag === "MissingDurableObjectNamespaces" ||
                error._tag === "WorkerHasNoVersions" ||
                error._tag === "WorkerNotFound",
              schedule: Schedule.exponential(100).pipe(
                Schedule.both(Schedule.recurs(20)),
              ),
            }),
          );
      });

      const prepareAssets = Effect.fn(function* (
        assets: WorkerProps["assets"],
      ) {
        if (!assets) {
          return undefined;
        }

        if (typeof assets === "object" && "hash" in assets) {
          const { hash: _, ...config } = assets;
          return yield* readAssets(config);
        }

        // Handle string path or AssetsProps
        return yield* readAssets(
          typeof assets === "string" ? { directory: assets } : assets,
        );
      });

      const prepareBundle = (id: string, props: WorkerProps) =>
        (props.bundle === false
          ? readPrebuiltWorkerBundle({
              main: props.main!,
              rules: props.rules,
            })
          : bundler.build({
              id,
              main: props.main!,
              compatibility: getCompatibility(props),
              entry: props.isExternal
                ? {
                    kind: "external",
                  }
                : {
                    kind: "effect",
                    exports: props.exports ?? {},
                  },
              stack: { name: stack.name, stage: stack.stage },
              extraOptions: props.build,
            })
        ).pipe(Artifacts.cached("build"));

      const hashScript = (script: string) =>
        Effect.sync(() =>
          crypto.createHash("sha256").update(script).digest("hex"),
        );

      const viteBuild = Effect.fn(function* (props: WorkerProps) {
        const compatibility = getCompatibility(props);
        // Loaded lazily: `./Vite.ts` pulls in `@distilled.cloud/cloudflare-vite-plugin`
        // (~0.5s), which is only needed for vite-based workers at build time —
        // not for every Worker definition at module-load time.
        const Vite = yield* Effect.promise(() => import("./Vite.ts"));
        const { assetsDirectory, serverBundle } = yield* Vite.viteBuild(
          props.vite?.rootDir,
          Object.fromEntries(
            (yield* Effect.all(
              Object.entries(props.env ?? {}).map(
                Effect.fn(function* ([key, value]) {
                  return [
                    key,
                    typeof value === "string"
                      ? value
                      : Redacted.isRedacted(value) &&
                          typeof Redacted.value(value) === "string"
                        ? Redacted.value(value)
                        : // A `WorkerLoader` is a real Effect that also carries
                          // the `~alchemy/Kind` marker — it is a binding, not a
                          // runnable env value. Check it before `Effect.isEffect`
                          // so we don't execute it as an inlined env entry.
                          isWorkerLoader(value)
                          ? undefined
                          : Effect.isEffect(value)
                            ? yield* value as Effect.Effect<any>
                            : undefined,
                  ];
                }),
              ),
            )).filter(([_, value]) => value !== undefined),
          ),
          {
            compatibilityDate: compatibility.date,
            compatibilityFlags: compatibility.flags,
          },
        );

        if (!assetsDirectory && !serverBundle) {
          return yield* Effect.die(
            new Error("Vite build produced neither server nor client output"),
          );
        }
        const [assets, bundle] = yield* Effect.all(
          [
            assetsDirectory
              ? readAssets({
                  ...(props.assets && typeof props.assets !== "string"
                    ? props.assets
                    : undefined),
                  directory: assetsDirectory,
                })
              : Effect.succeed(undefined),
            serverBundle
              ? Bundle.bundleOutputFromRolldownOutputBundle(serverBundle)
              : Effect.succeed(undefined),
          ],
          { concurrency: "unbounded" },
        );
        return { assets, bundle };
      });

      const prepareAssetsAndBundle = (
        id: string,
        props: WorkerProps,
        opts: { skipAssetsRead?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          if (props.script !== undefined) {
            const [assets, bundleHash] = yield* Effect.all(
              [
                opts.skipAssetsRead
                  ? Effect.succeed(undefined)
                  : prepareAssets(props.assets),
                hashScript(props.script),
              ],
              { concurrency: "unbounded" },
            );
            return {
              assets,
              bundle: {
                files: [{ path: "main.js", content: props.script }],
                hash: bundleHash,
              },
            };
          }
          if (props.vite) {
            const [{ assets, bundle }, input] = yield* Effect.all(
              [
                viteBuild(props),
                // hashDirectory expects `{ cwd, memo }`. The vite props
                // store the project root under `rootDir`, so map it
                // here. Without this, `cwd` falls back to
                // `process.cwd()` and the input hash is computed over
                // the wrong directory tree (often the entire monorepo
                // root), making it both slow and unable to detect
                // changes scoped to the actual Vite project.
                hashDirectory({
                  cwd: props.vite.rootDir,
                  memo: props.vite.memo,
                }),
              ],
              { concurrency: "unbounded" },
            );
            return { assets, bundle, input };
          }
          const [assets, bundle] = yield* Effect.all(
            [
              opts.skipAssetsRead
                ? Effect.succeed(undefined)
                : prepareAssets(props.assets),
              prepareBundle(id, props),
            ],
            { concurrency: "unbounded" },
          );
          return { assets, bundle };
        }).pipe(
          Effect.map(({ assets, bundle, input }) => ({
            assets,
            bundle: {
              main: bundle?.files[0].path,
              files: bundle?.files.map(
                (file) =>
                  new File([file.content as BlobPart], file.path, {
                    type: contentTypeFromExtension(path.extname(file.path)),
                  }),
              ),
            },
            hash: {
              assets: assets?.hash,
              bundle: bundle?.hash,
              input,
            } satisfies Worker["Attributes"]["hash"],
          })),
        );

      const normalizePrebuiltAssets = (
        assets: WorkerProps["assets"],
        output: Worker["Attributes"] | undefined,
      ) => {
        if (!Predicate.hasProperty(assets, "hash")) return undefined;
        const { directory: _, hash, ...config } = assets;
        return { config, hash, skip: hash === output?.hash?.assets };
      };

      const putWorker = Effect.fn(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
        existingSettings?: workers.GetScriptScriptAndVersionSettingResponse,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const name = yield* createWorkerName(id, news.name);
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: preparing bundle for ${name}`,
        );
        // If the caller handed us a precomputed asset hash that matches
        // what we previously stored, we can skip walking the directory
        // entirely and tell Cloudflare to keep the assets it already
        // has bound to this script. The disk read is the expensive
        // part; the script PUT happens either way.
        const prebuiltAssets = normalizePrebuiltAssets(news.assets, output);
        const {
          assets,
          bundle,
          hash: preparedHash,
        } = yield* prepareAssetsAndBundle(id, news, {
          skipAssetsRead: prebuiltAssets?.skip,
        });
        // When the caller supplied a precomputed hash (e.g. via
        // `Command.Build`), store *that* hash in output state so the
        // next diff can short-circuit by comparing it directly. The
        // hash that `readAssets` produces is the manifest-derived
        // hash, which is shaped differently from any upstream
        // build-input hash and will never match it on the next pass.
        const hash = {
          ...preparedHash,
          assets: prebuiltAssets?.hash ?? preparedHash.assets,
        } satisfies Worker["Attributes"]["hash"];
        const metadataBindings = bindings.flatMap((b) => b.data.bindings ?? []);
        const expectedDurableObjectClassNames =
          getExpectedDurableObjectClassNames(metadataBindings, name);
        let metadataAssets:
          | workers.PutScriptRequest["metadata"]["assets"]
          | undefined;
        let keepAssets = false;
        if (prebuiltAssets?.skip) {
          // Hash matched what's already on Cloudflare: keep the
          // existing asset manifest and skip the upload session.
          yield* Effect.logInfo(
            `Cloudflare Worker update: assets unchanged for ${name}, keeping existing`,
          );
          keepAssets = true;
          metadataAssets = { config: prebuiltAssets.config };
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        } else if (assets) {
          // We had to read the directory. Even after the read, the
          // computed hash may match what's already deployed (e.g.
          // legacy `string` / `AssetsProps` shapes that don't carry a
          // precomputed hash, or a precomputed hash that disagreed with
          // disk). In that case still keep the existing manifest and
          // skip the upload session — Cloudflare's content-addressed
          // session would no-op on every byte anyway.
          if (assets.hash === prebuiltAssets?.hash) {
            yield* Effect.logInfo(
              `Cloudflare Worker update: assets unchanged for ${name}, keeping existing`,
            );
            keepAssets = true;
            metadataAssets = { config: assets.config };
          } else {
            yield* Effect.logInfo(
              `Cloudflare Worker ${olds ? "update" : "create"}: uploading assets for ${name}`,
            );
            const { jwt } = yield* uploadAssets(
              accountId,
              name,
              assets,
              session,
            );
            metadataAssets = {
              jwt,
              config: assets.config,
            };
          }
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        }
        metadataBindings.push(
          {
            type: "plain_text",
            name: "ALCHEMY_PHASE",
            text: "runtime",
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STACK_NAME",
            text: stack.name,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STAGE",
            text: stack.stage,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
            text: accountId,
          },
        );
        // Add environment variables as metadata bindings
        if (news.env) {
          for (const [key, value] of Object.entries(news.env)) {
            if (value === undefined) continue;
            if (metadataBindings.some((b) => b.name === key)) continue;
            if (Redacted.isRedacted(value)) {
              const unredacted = Redacted.value(value);
              metadataBindings.push({
                type: "secret_text",
                name: key,
                text:
                  typeof unredacted === "string"
                    ? unredacted
                    : JSON.stringify(unredacted),
              });
            } else if (typeof value === "string") {
              metadataBindings.push({
                type: "plain_text",
                name: key,
                text: value,
              });
            } else {
              metadataBindings.push({
                type: "json",
                name: key,
                json: value,
              });
            }
          }
        }
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: uploading script for ${name}`,
        );
        const size =
          bundle.files
            ?.filter((file) => !file.name.endsWith(".map"))
            .reduce((acc, file) => acc + file.size, 0) ?? 0;
        const sizeKB = size / 1024;
        const sizeMB = sizeKB / 1024;
        const bundleSize = `${sizeKB > 1024 ? `${sizeMB.toFixed(2)} MB` : `${sizeKB.toFixed(2)} KB`}`;
        yield* session.note(`Uploading worker (${bundleSize}) ...`);

        // Read existing worker settings for migration tracking
        const oldSettings =
          existingSettings ??
          (yield* workers
            .getScriptScriptAndVersionSetting({
              accountId,
              scriptName: name,
            })
            .pipe(
              Effect.map((s) => s as typeof s | undefined),
              Effect.catch(() => Effect.succeed(undefined)),
            ));

        const oldTags = Array.from(new Set(oldSettings?.tags ?? []));
        const oldBindings = oldSettings?.bindings ?? [];

        // Parse alchemy:do:{logicalId}:{className} tags
        const oldDoClassNameByLogicalId = getDurableObjectTagMap(oldTags);
        const currentDoBindings = getDurableObjectBindings(bindings, name);
        const currentDoClassNameByLogicalId = Object.fromEntries(
          currentDoBindings.map((binding) => [
            binding.logicalId,
            binding.className,
          ]),
        );

        // Parse alchemy:migration-tag:{version}
        const oldMigrationTag = oldTags.flatMap((tag) =>
          tag.startsWith("alchemy:migration-tag:")
            ? [tag.slice("alchemy:migration-tag:".length)]
            : [],
        )[0];
        const newMigrationTag = bumpMigrationTagVersion(oldMigrationTag);

        // Compute deleted classes
        const deletedClasses: string[] = [];
        for (const [logicalId, className] of Object.entries(
          oldDoClassNameByLogicalId,
        )) {
          if (!currentDoClassNameByLogicalId[logicalId]) {
            deletedClasses.push(className);
          }
        }

        // Backward compatibility for old workers that have DO bindings but no
        // alchemy:do tags yet. Cross-script bindings (`scriptName` set to
        // anything other than this worker) are NEVER candidates for
        // delete-class migrations — the class lives on the foreign script
        // and we don't own its lifecycle.
        if (Object.keys(oldDoClassNameByLogicalId).length === 0) {
          for (const oldBinding of oldBindings) {
            const ownedLocally =
              !("scriptName" in oldBinding) || oldBinding.scriptName === name;
            if (
              oldBinding.type === "durable_object_namespace" &&
              "className" in oldBinding &&
              oldBinding.className &&
              ownedLocally &&
              !currentDoBindings.some(
                (binding) => binding.bindingName === oldBinding.name,
              )
            ) {
              deletedClasses.push(oldBinding.className);
            }
          }
        }

        // Collect container-backed class names so we can send container metadata
        const containerClassNames = new Set(
          bindings.flatMap((b) =>
            (b.data.containers ?? []).map((c) => c.className),
          ),
        );

        // Compute new and renamed classes
        const newClasses: string[] = [];
        const newSqliteClasses: string[] = [];
        const renamedClasses: { from: string; to: string }[] = [];
        for (const binding of currentDoBindings) {
          const previousClassName =
            oldDoClassNameByLogicalId[binding.logicalId];
          if (!previousClassName) {
            // Default all new Durable Object classes to SQLite. Cloudflare
            // recommends SQLite for new namespaces, and container-backed
            // Durable Objects require it.
            newSqliteClasses.push(binding.className);
          } else if (previousClassName !== binding.className) {
            renamedClasses.push({
              from: previousClassName,
              to: binding.className,
            });
          }
        }

        yield* Effect.logInfo(
          `Cloudflare Worker put: durable object reconciliation ${JSON.stringify(
            {
              oldDoClassNameByLogicalId,
              currentDoClassNameByLogicalId,
              deletedClasses,
              renamedClasses,
              newSqliteClasses,
            },
          )}`,
        );

        // Build alchemy:do:{logicalId}:{className} tags for each DO binding
        const alchemyDoTags: string[] = [];
        for (const binding of currentDoBindings) {
          alchemyDoTags.push(
            `alchemy:do:${binding.logicalId}:${binding.className}`,
          );
        }

        const metadataTags = Array.from(
          new Set([
            ...createAlchemyWorkerTags(id),
            ...alchemyDoTags,
            ...(newMigrationTag
              ? [`alchemy:migration-tag:${newMigrationTag}`]
              : []),
            ...(news.tags ?? []),
          ]),
        );

        const migrations = {
          oldTag: oldMigrationTag,
          newTag: newMigrationTag,
          newClasses,
          deletedClasses,
          renamedClasses,
          transferredClasses: [] as { from: string; to: string }[],
          newSqliteClasses,
        };

        const metadataContainers = [...containerClassNames].map(
          (className) => ({
            className,
          }),
        );

        const compatibility = getCompatibility(news);
        const metadata: workers.PutScriptRequest["metadata"] = {
          assets: metadataAssets,
          bindings: metadataBindings,
          bodyPart: undefined,
          compatibilityDate: compatibility.date,
          compatibilityFlags: compatibility.flags,
          containers:
            metadataContainers.length > 0 ? metadataContainers : undefined,
          keepAssets,
          keepBindings: undefined,
          limits: news.limits,
          logpush: news.logpush,
          mainModule: bundle.main,
          migrations,
          observability: news.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocationLogs: true,
            },
          },
          placement: news.placement,
          tags: metadataTags,
          tailConsumers: undefined,
          usageModel: undefined,
        };
        const worker = yield* workers
          .putScript({
            accountId,
            scriptName: name,
            metadata,
            files: bundle.files,
          })
          .pipe(
            Effect.catch((err) => {
              // When adopting a Worker managed by Wrangler (or after a previous
              // deploy with mismatched migrations), the old_tag precondition
              // fails. The only way to discover the actual tag is through the
              // error message — getScriptSettings is meant to return it but
              // doesn't at runtime.
              const msg = String(
                typeof err === "object" && err !== null && "message" in err
                  ? err.message
                  : err,
              );
              const expectedTag = msg.match(
                /when expected tag is ['"]?([^'"]+)['"]?/,
              )?.[1];
              if (expectedTag) {
                return workers.putScript({
                  accountId,
                  scriptName: name,
                  metadata: {
                    ...metadata,
                    migrations: {
                      ...migrations,
                      oldTag: expectedTag,
                      newTag: bumpMigrationTagVersion(expectedTag),
                    },
                  },
                  files: bundle.files,
                });
              }
              return Effect.fail(err as any);
            }),
          );
        const { settings, durableObjectNamespaces } =
          yield* getWorkerSettingsWithDurableObjects(
            name,
            expectedDurableObjectClassNames,
          );
        // Reconcile workers.dev subdomain against observed cloud state.
        // We can't diff `news.url` against `olds.url` here because both
        // default to `undefined` (meaning "enable") — that comparison
        // would skip the API call on every deploy where the user never
        // explicitly set `url`, leaving the subdomain in whatever state
        // Cloudflare currently has it (disabled by default, or whatever
        // a previous failed/external action left it as).
        const desiredSubdomainEnabled = news.url !== false;
        const observedSubdomain = yield* workers
          .getScriptSubdomain({
            accountId,
            scriptName: name,
          })
          .pipe(
            Effect.orElseSucceed<workers.GetScriptSubdomainResponse>(() => ({
              enabled: false,
              previewsEnabled: false,
            })),
          );
        if (
          desiredSubdomainEnabled !== observedSubdomain.enabled ||
          desiredSubdomainEnabled !== observedSubdomain.previewsEnabled
        ) {
          yield* session.note(
            `${desiredSubdomainEnabled ? "Enabling" : "Disabling"} workers.dev subdomain...`,
          );
          // Cloudflare's script registry is eventually consistent — for the
          // first few hundred ms after `putScript` returns, POST /subdomain
          // can still get back `WorkerNotFound` (a generic "unknown error"
          // body), or a bare 500 surfaced as `InternalServerError` /
          // `UnknownCloudflareError` (code 10013). Bigger uploads race harder.
          // Retry the subdomain toggle on those transient tags with a short
          // exponential backoff; same pattern we use elsewhere in this
          // provider for DO-namespace propagation and for `putScript` itself.
          yield* setWorkerSubdomain(name, desiredSubdomainEnabled).pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "WorkerNotFound" ||
                error._tag === "InternalServerError" ||
                error._tag === "UnknownCloudflareError",
              schedule: Schedule.exponential(200).pipe(
                Schedule.both(Schedule.recurs(15)),
              ),
            }),
          );
        }
        const desiredDomains = normalizeDomains(news.domain);
        const previousDomains = output?.domains ?? [];
        if (desiredDomains.length > 0 || previousDomains.length > 0) {
          yield* session.note(
            `Reconciling custom domains (${desiredDomains.length}) ...`,
          );
        }
        const reconciled = yield* reconcileDomains(name, desiredDomains);
        const workersDevUrl =
          news.url !== false
            ? `https://${name}.${yield* getAccountSubdomain(accountId)}.workers.dev`
            : undefined;
        const domains = [
          ...reconciled.map((d) => `https://${d.hostname}`),
          ...(workersDevUrl ? [workersDevUrl] : []),
        ];
        const crons = yield* reconcileCrons(
          name,
          normalizeCrons([...getCronBindings(bindings), ...(news.crons ?? [])]),
          output?.crons ?? [],
          session,
        );
        return {
          workerId: worker.id ?? name,
          workerName: name,
          logpush: worker.logpush ?? undefined,
          url: domains[0],
          tags: settings.tags ?? metadata.tags,
          durableObjectNamespaces,
          accountId,
          domains,
          crons,
          hash,
        } satisfies Worker["Attributes"];
      });

      const hasChanged = Effect.fn(function* (
        id: string,
        props: WorkerProps,
        output: Worker["Attributes"],
      ) {
        if (props.script !== undefined) {
          const scriptHash = yield* hashScript(props.script);
          if (scriptHash !== output.hash?.bundle) {
            return true;
          }
          if (!props.assets) {
            return false;
          }
          const assetsHash = Predicate.hasProperty(props.assets, "hash")
            ? props.assets.hash
            : undefined;
          if (assetsHash === undefined) {
            return true;
          }
          return assetsHash !== output.hash?.assets;
        }
        if (props.vite) {
          const input = yield* hashDirectory({
            cwd: props.vite.rootDir,
            memo: props.vite.memo,
          });
          return input !== output.hash?.input;
        }
        const bundleHash = yield* prepareBundle(id, props).pipe(
          Effect.map((b) => b.hash),
        );
        if (bundleHash !== output.hash?.bundle) {
          return true;
        }
        if (!props.assets) {
          return false;
        }
        // We deliberately don't read the assets directory during diff.
        // For `AssetsWithHash` (the documented contract) the upstream
        // `Command.Build` already gave us an authoritative hash — we
        // just compare strings. Reading the directory here would
        // (a) hash the same tree twice per apply (`putWorker` reads
        // again when an upload is actually required), and (b) crash
        // when the prior state was written on a different machine
        // and `path` doesn't exist locally — blocking any local
        // reapply even though the precomputed hash is right there
        // in props.
        //
        // For the legacy `string` / `AssetsProps` shapes there's no
        // hash in props to compare against, so we conservatively
        // assume the assets changed; `putWorker` will read once,
        // hash, and use `keepAssets` if it turns out nothing actually
        // changed.
        const assetsHash = Predicate.hasProperty(props.assets, "hash")
          ? props.assets.hash
          : undefined;
        if (assetsHash === undefined) {
          return true;
        }
        return assetsHash !== output.hash?.assets;
      });

      return Worker.Provider.of({
        stables: ["workerId", "workerName"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Account-scoped enumeration of every Worker script. The
            // per-script `read` makes several extra calls (subdomain,
            // settings, domains, schedule) to fully hydrate
            // url/durableObjectNamespaces/domains/crons. Doing that for
            // every script on the account is both expensive (4 calls × N)
            // and fragile — a single script with a binding shape the
            // settings schema doesn't know about would break the whole
            // listing (the same reason `read` deliberately avoids
            // `listScripts`). For `list()` we hydrate the core identifying
            // and settings fields that come straight from the script
            // metadata and leave the binding-derived fields at the same
            // defaults `read` returns when those sub-resources are absent
            // (`url: undefined`, `durableObjectNamespaces: {}`,
            // `domains: []`, `crons: []`). `accountId` + `workerName` are
            // sufficient for `delete`.
            return yield* workers.listScripts.pages({ accountId }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  // Annotate the element type as the full `Attributes` shape
                  // (incl. the optional `hash`) so it matches `read` exactly.
                  // `list()` is an inference source for the provider's resource
                  // type; a narrower element (e.g. via `satisfies`, which omits
                  // `hash`) would derail `Res` inference and cascade every
                  // lifecycle method's requirement channel to `never`.
                  (page.result ?? []).flatMap(
                    (script): Worker["Attributes"][] =>
                      script.id
                        ? [
                            {
                              accountId,
                              workerId: script.id,
                              workerName: script.id,
                              logpush: script.logpush ?? undefined,
                              url: undefined,
                              tags: script.tags ?? undefined,
                              durableObjectNamespaces: {},
                              domains: [],
                              crons: [],
                            },
                          ]
                        : [],
                  ),
                ),
              ),
            );
          }),
        diff: Effect.fn(function* ({ id, news, olds, output, newBindings }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" };
          }
          const workerName = yield* createWorkerName(id, news.name);
          const oldWorkerName = output?.workerName
            ? output.workerName
            : yield* createWorkerName(id, olds?.name);
          if (workerName !== oldWorkerName) {
            return { action: "replace" };
          }
          if (!output) {
            return;
          }
          const newDomains = normalizeDomains(news.domain)
            .map((h) => `https://${h}`)
            .sort();
          const oldDomains = (output?.domains ?? [])
            .filter((u) => !u.endsWith(".workers.dev"))
            .sort();
          const domainsChanged =
            newDomains.length !== oldDomains.length ||
            newDomains.some((d, i) => d !== oldDomains[i]);
          const newCrons = normalizeCrons([
            ...(Array.isArray(newBindings)
              ? getCronBindings(
                  newBindings as ResourceBinding<Worker["Binding"]>[],
                )
              : []),
            ...(news.crons ?? []),
          ]).sort();
          const oldCrons = [...(output?.crons ?? [])].sort();
          const cronsChanged =
            newCrons.length !== oldCrons.length ||
            newCrons.some((cron, index) => cron !== oldCrons[index]);
          // `url` is `domains[0]`: the first custom domain in user order if
          // any, otherwise the workers.dev URL (derived from the stable
          // worker name + account subdomain). It's stable across this update
          // exactly when that first domain is unchanged — which is NOT the
          // same as "the domain set is unchanged": adding a second custom
          // domain leaves `url` put, while reordering changes it even though
          // the set is equal. Compute the resulting `url` and carry it
          // forward as a stable only when it matches the old one, so
          // downstream resources that reference `worker.url` (e.g. a GitHub
          // Webhook delivery URL built via `Output.interpolate`) resolve it
          // to a concrete value during planning instead of an unresolved
          // Output — otherwise every worker update spuriously re-updates them.
          const newCustomDomains = normalizeDomains(news.domain);
          const newUrl =
            newCustomDomains.length > 0
              ? `https://${newCustomDomains[0]}`
              : news.url !== false
                ? (output.domains ?? []).find((u) => u.endsWith(".workers.dev"))
                : undefined;
          const urlStable = newUrl !== undefined && newUrl === output.url;
          // `durableObjectNamespaces` maps each hosted DO class name to the
          // namespace id Cloudflare assigned it. Those ids are permanent for
          // the lifetime of a (worker, class) pair, so the map only changes
          // when a class is added or removed — never on a plain code/config
          // update. Carry it forward as a stable whenever the set of local DO
          // class names is unchanged, for the same reason as `url` above:
          // downstream resources that bind a DO namespace via
          // `worker.durableObjectNamespaces[name]` (e.g. a Container attached
          // to a DO) must resolve it to a concrete value during planning.
          // Otherwise the binding holds an unresolved Output, which
          // `diffBindings` treats as "changed", spuriously re-updating the
          // bound resource on every deploy. Class names are structural (not the
          // namespace id), so this comparison holds even when `newBindings` is
          // otherwise unresolved.
          const newDoClassNames = Array.isArray(newBindings)
            ? getExpectedDurableObjectClassNames(
                (newBindings as ResourceBinding<Worker["Binding"]>[]).flatMap(
                  (b) => b.data.bindings ?? [],
                ),
                workerName,
              ).sort()
            : [];
          const oldDoClassNames = Object.keys(
            output.durableObjectNamespaces ?? {},
          ).sort();
          const doNamespacesStable =
            oldWorkerName === workerName &&
            newDoClassNames.length === oldDoClassNames.length &&
            newDoClassNames.every((name, i) => name === oldDoClassNames[i]);
          if (
            domainsChanged ||
            cronsChanged ||
            (yield* hasChanged(id, news, output))
          ) {
            // `workerId` is always stable across an update; seed it so it
            // survives now that `diff.stables` overrides `provider.stables`
            // rather than being merged with it.
            const stables: string[] = ["workerId"];
            if (oldWorkerName === workerName) {
              stables.push("workerName");
            }
            if (urlStable) {
              stables.push("url");
            }
            if (doNamespacesStable) {
              stables.push("durableObjectNamespaces");
            }
            return {
              action: "update",
              stables: stables.length > 0 ? stables : undefined,
            };
          }
        }),
        precreate: Effect.fn(function* ({ id, news, session }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const name = yield* createWorkerName(id, news.name);
          const exportMap = news.exports ?? {};
          const durableObjects = Object.keys(exportMap)
            .filter((logicalId) => isDurableObjectExport(exportMap[logicalId]))
            .map((logicalId) => ({
              logicalId,
              className: logicalId,
            }));
          const doClasses = durableObjects.map((binding) => binding.className);
          const containers = doClasses.map((className) => ({ className }));
          const alchemyDoTags = durableObjects.map(
            ({ logicalId, className }) =>
              `alchemy:do:${logicalId}:${className}`,
          );
          const tags = Array.from(
            new Set([
              ...createAlchemyWorkerTags(id),
              ...alchemyDoTags,
              ...(news.tags ?? []),
            ]),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );
          const existingSettings = yield* workers
            .getScriptScriptAndVersionSetting({
              accountId,
              scriptName: name,
            })
            .pipe(
              // A freshly pre-created stub can briefly report "has no
              // versions" before its first version registers — treat it the
              // same as a missing worker (nothing to adopt yet).
              Effect.catchTag("WorkerNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("WorkerHasNoVersions", () =>
                Effect.succeed(undefined),
              ),
            );
          let durableObjectNamespaces = getDurableObjectNamespaces(
            existingSettings?.bindings,
          );

          if (existingSettings) {
            // Engine has already cleared this resource for write via
            // `read` + AdoptPolicy. Either we own it (matching tags) or
            // the user opted in to a takeover (`--adopt` / `adopt(true)`).
            yield* Effect.logInfo(
              `Cloudflare Worker precreate: reusing existing ${name}`,
            );
          } else {
            yield* session.note("Pre-creating worker...");
            const mainModule = "main.js";
            const placeholderScript = `${doClasses.length > 0 ? 'import { DurableObject } from "cloudflare:workers";\n\n' : ""}export default { fetch() { return new Response("Alchemy worker is being deployed...") } };\n${doClasses
              .map(
                (className) =>
                  `export class ${className} extends DurableObject {}`,
              )
              .join("\n")}`;
            yield* workers
              .putScript({
                accountId,
                scriptName: name,
                metadata: {
                  mainModule,
                  bindings:
                    doClasses.length > 0
                      ? doClasses.map((className) => ({
                          type: "durable_object_namespace" as const,
                          name: className,
                          className,
                        }))
                      : undefined,
                  ...getCompatibility(news),
                  containers,
                  migrations:
                    doClasses.length > 0
                      ? {
                          oldTag: undefined,
                          newTag: undefined,
                          newClasses: [],
                          deletedClasses: [],
                          renamedClasses: [],
                          transferredClasses: [],
                          newSqliteClasses: doClasses,
                        }
                      : undefined,
                  observability: news.observability ?? {
                    enabled: true,
                    logs: {
                      enabled: true,
                      invocationLogs: true,
                    },
                  },
                  tags,
                },
                files: [
                  new File([placeholderScript], mainModule, {
                    type: "application/javascript+module",
                  }),
                ],
              })
              .pipe(
                // Cloudflare's PUT /workers/scripts/{name} intermittently
                // returns code 10002 / "An unknown error has occurred" on the
                // first put for a fresh worker name. Surfaced as the shared
                // `InternalServerError` upstream (alchemy-run/distilled#290).
                // Also match `UnknownCloudflareError` for older
                // @distilled.cloud/cloudflare versions that haven't picked
                // up the patch yet.
                Effect.retry({
                  while: (e) =>
                    e._tag === "InternalServerError" ||
                    e._tag === "UnknownCloudflareError",
                  schedule: Schedule.exponential(1000).pipe(
                    Schedule.both(Schedule.recurs(5)),
                  ),
                }),
              );
            if (doClasses.length > 0) {
              ({ durableObjectNamespaces } =
                yield* getWorkerSettingsWithDurableObjects(name, doClasses));
            }
          }

          if (existingSettings && doClasses.length > 0) {
            ({ durableObjectNamespaces } =
              yield* getWorkerSettingsWithDurableObjects(name, doClasses));
          }

          return {
            workerId: name,
            workerName: name,
            logpush: existingSettings?.logpush ?? undefined,
            url: undefined,
            tags: existingSettings?.tags ?? tags,
            durableObjectNamespaces,
            accountId,
            domains: [],
            crons: [],
          } satisfies Worker["Attributes"];
        }),
        read: Effect.fn(
          function* ({ id, output, olds }) {
            const { accountId } = yield* yield* CloudflareEnvironment;
            const workerName =
              output?.workerName ?? (yield* createWorkerName(id, olds?.name));
            yield* Effect.logInfo(
              `Cloudflare Worker read: checking ${workerName}`,
            );
            // We deliberately don't call `listScripts({ accountId })` here:
            // it pulls every Worker on the account back through a strict
            // schema decode, and a single existing Worker the schema doesn't
            // know about (e.g. `placement_mode: "targeted"`) breaks the
            // entire read. `getScriptSettings` already fails with
            // `WorkerNotFound` if the script doesn't exist, which the
            // surrounding `Effect.catchTag` turns into `undefined` — that's
            // all the existence check we need.
            const [subdomain, settings, domainsList] = yield* Effect.all([
              workers.getScriptSubdomain({
                accountId,
                scriptName: workerName,
              }),
              workers.getScriptScriptAndVersionSetting({
                accountId,
                scriptName: workerName,
              }),
              workers
                .listDomains({
                  accountId,
                  service: workerName,
                })
                .pipe(Effect.map((r) => r.result ?? [])),
            ]);
            // Preserve the order the user provided in `olds.domain`. The
            // Cloudflare API returns domains in non-deterministic order,
            // which would cause downstream `worker.domains[0]` reads to flip
            // between deploys. Drift (domains we don't know about) is
            // appended after the user-ordered ones.
            const userOrder = normalizeDomains(olds?.domain);
            const orderedHostnames = [
              ...userOrder.flatMap(
                (h) =>
                  domainsList.find((d) => d.hostname === h)?.hostname ?? [],
              ),
              ...domainsList.flatMap((d) =>
                d.hostname && !userOrder.includes(d.hostname)
                  ? [d.hostname]
                  : [],
              ),
            ];
            const workersDevUrl = subdomain.enabled
              ? `https://${workerName}.${yield* getAccountSubdomain(accountId)}.workers.dev`
              : undefined;
            const domains = [
              ...orderedHostnames.map((h) => `https://${h}`),
              ...(workersDevUrl ? [workersDevUrl] : []),
            ];
            const crons = yield* getWorkerCrons(workerName);
            yield* Effect.logInfo(
              `Cloudflare Worker read: found ${workerName}`,
            );
            const attrs = {
              accountId,
              workerId: workerName,
              workerName,
              logpush: settings.logpush ?? undefined,
              url: domains[0],
              tags: settings.tags ?? undefined,
              durableObjectNamespaces: getDurableObjectNamespaces(
                settings.bindings,
              ),
              domains,
              crons,
            } satisfies Worker["Attributes"];

            // Centralized ownership decision: the engine routes `read`'s
            // return value based on `AdoptPolicy`. We hand it the attrs
            // either as-is (owned: alchemy tags identify this stack/stage/id,
            // safe to silently adopt even without `--adopt`) or branded with
            // `Unowned` (caller must opt in via `--adopt` or the engine
            // raises `OwnedBySomeoneElse`).
            return hasAlchemyWorkerTags(id, settings.tags ?? [])
              ? attrs
              : Unowned(attrs);
          },
          (effect) =>
            effect.pipe(
              // A worker that exists but hasn't registered a version yet reads
              // as "not deployed" — fall through to (re)create like NotFound.
              Effect.catchTag("WorkerNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("WorkerHasNoVersions", () =>
                Effect.succeed(undefined),
              ),
            ),
        ),
        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const name =
            output?.workerName ?? (yield* createWorkerName(id, news.name));
          const durableObjects = getDurableObjectBindings(bindings, name).map(
            ({ logicalId, className }) => ({
              logicalId,
              className,
            }),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );

          // Observe — fetch the script's current settings if it already exists.
          // `putWorker` is a true upsert against the Cloudflare API; the
          // existing settings inform asset/migration decisions and let the
          // reconciler converge whether the worker is brand-new, adopted, or
          // an in-place update.
          const existingSettings = yield* workers
            .getScriptScriptAndVersionSetting({
              accountId,
              scriptName: name,
            })
            .pipe(
              // After a pre-create stub (or under a busy account right after
              // the first upload) the settings read can race the script
              // registry and 404 with "has no versions". Treat it as "no
              // existing settings" so reconcile proceeds to upload/converge.
              Effect.catchTag("WorkerNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("WorkerHasNoVersions", () =>
                Effect.succeed(undefined),
              ),
            );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: existing durable object tags ${JSON.stringify(
              (existingSettings?.tags ?? []).filter((tag) =>
                tag.startsWith("alchemy:do:"),
              ),
            )}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: previous durable object tags ${JSON.stringify(
              (output?.tags ?? []).filter((tag) =>
                tag.startsWith("alchemy:do:"),
              ),
            )}`,
          );
          return yield* putWorker(
            id,
            news,
            bindings,
            olds,
            output,
            session,
            existingSettings,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Worker delete: deleting ${output.workerName}`,
          );
          // Look up live domain IDs rather than trusting persisted state.
          // We no longer track `{ id, zoneId }` on the output; fetching
          // straight from Cloudflare handles both the normal case and
          // adopted workers whose domains we never recorded.
          const liveDomains = yield* workers
            .listDomains({
              accountId: output.accountId,
              service: output.workerName,
            })
            .pipe(
              Effect.map((r) => r.result ?? []),
              Effect.catch(() => Effect.succeed([])),
            );
          if (liveDomains.length) {
            yield* Effect.all(
              liveDomains.flatMap((d) =>
                d.id
                  ? [
                      workers
                        .deleteDomain({
                          accountId: output.accountId,
                          domainId: d.id,
                        })
                        .pipe(
                          Effect.catchTag("DomainNotFound", () => Effect.void),
                        ),
                    ]
                  : [],
              ),
              { concurrency: "unbounded" },
            );
          }
          yield* workers
            .deleteScript({
              accountId: output.accountId,
              scriptName: output.workerName,
              // Force teardown of queue consumers, durable object classes, and
              // service bindings hanging off this worker. Without `force`, those
              // conditions raise QueueConsumerConflict / ServiceBindingConflict
              // and leave the script in CF. Alchemy is the source of truth for
              // the worker, so we want a hard delete on teardown.
              force: true,
            })
            .pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
        }),
        tail: ({ output }) =>
          telemetry.tailScript({
            accountId: output.accountId,
            scriptName: output.workerName,
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: output.workerName,
              },
            ],
            options,
          }),
      });
    }),
  );

const contentTypeFromExtension = (extension: string) => {
  switch (extension) {
    case ".wasm":
      return "application/wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    case ".mjs":
    case ".js":
      return "application/javascript+module";
    case ".cjs":
      return "application/javascript";
    case ".map":
      return "application/source-map";
    default:
      return "application/octet-stream";
  }
};

function bumpMigrationTagVersion(
  oldTag: string | undefined,
): string | undefined {
  if (!oldTag) return undefined;
  const version = oldTag.match(/^(alchemy:)?v(\d+)$/)?.[2];
  if (!version) return "alchemy:v1";
  return `alchemy:v${parseInt(version, 10) + 1}`;
}

function getDurableObjectBindings(
  bindings: ReadonlyArray<ResourceBinding>,
  workerName: string,
) {
  // Resource authors (and the `make`/`yield* Tag`/plan-vs-apply machinery)
  // can register the same DO binding multiple times under the same logical
  // id — `binding()` is a plain `worker.bind` and intentionally has no
  // dedup. Collapse duplicates here so each `(logicalId, bindingName,
  // className)` tuple appears at most once. We also exclude cross-script
  // references: a `scriptName` pointing to *another* worker means this
  // worker just references a foreign class — ship the binding to
  // Cloudflare, but don't drive class migrations for it.
  const seen = new Set<string>();
  return bindings.flatMap((binding) =>
    (binding.data.bindings ?? []).flatMap((item: WorkerBinding) => {
      if (
        item.type !== "durable_object_namespace" ||
        !("className" in item) ||
        !item.className
      ) {
        return [];
      }
      if (item.scriptName !== undefined && item.scriptName !== workerName) {
        return [];
      }
      const dedupKey = `${binding.sid}::${item.name}::${item.className}`;
      if (seen.has(dedupKey)) return [];
      seen.add(dedupKey);
      return [
        {
          logicalId: binding.sid,
          bindingName: item.name,
          className: item.className,
        },
      ];
    }),
  );
}

function getDurableObjectTagMap(tags: ReadonlyArray<string>) {
  return Object.fromEntries(
    tags.flatMap((tag) => {
      if (!tag.startsWith("alchemy:do:")) {
        return [];
      }
      const parts = tag.split(":");
      const logicalId = parts[2];
      const className = parts.slice(3).join(":");
      return logicalId && className ? [[logicalId, className]] : [];
    }),
  );
}
