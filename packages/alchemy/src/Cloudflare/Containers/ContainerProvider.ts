import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { type ResourceBinding } from "../../Resource.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { isLiveId } from "../LocalRuntime.ts";
import { CloudflareLogs, type TelemetryFilter } from "../Logs.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
} from "./ContainerApplication.ts";
import {
  createContainerApplicationName,
  makeContainerEnv,
} from "./ContainerBundle.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";
import { resolveContainerImage } from "./ContainerImage.ts";

export const LiveContainerProvider = () =>
  Provider.effect(
    ContainerPlatform,
    Effect.gen(function* () {
      const telemetry = yield* CloudflareLogs;

      const createApplicationName = createContainerApplicationName;

      const findApplicationByName = Effect.fn(function* (name: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.name === name)),
        );
      });

      const findApplicationByNamespace = Effect.fn(function* (
        namespaceId: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) =>
            apps.find((app) => app.durableObjects?.namespaceId === namespaceId),
          ),
        );
      });

      // After deleting an application by id, Cloudflare's account-scoped
      // `list` endpoint stays eventually-consistent for a short window and can
      // keep returning the now-deleted row. A subsequent recreate that
      // re-discovers the application by name (`createApplication`) would then
      // "adopt" that stale row and try to UPDATE it — which fails permanently
      // with `ContainerApplicationNotFound` (the app is really gone) and
      // exhausts the readiness retry. Block until the deleted id no longer
      // appears under that name (or a different id has taken the name, i.e. a
      // concurrent recreate) before proceeding. Bounded by the readiness
      // schedule; if it never clears we fall through and let create handle it.
      const waitForApplicationDeleted = (name: string, deletedId: string) =>
        findApplicationByName(name).pipe(
          Effect.repeat({
            schedule: containerApplicationReadinessSchedule,
            until: (app) => app?.id !== deletedId,
          }),
          Effect.asVoid,
        );

      const desiredConfiguration = (
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
        imageRef: string,
      ) =>
        normalizeNulls({
          image: imageRef,
          // Default to wrangler's instance type ("lite") so containers schedule
          // the same way out of the box. `instance_type` is mutually exclusive
          // with explicit vcpu/memory/disk, so only default it when none are
          // set. ("dev" is wrangler's deprecated alias for "lite".)
          instanceType:
            props.instanceType ??
            (props.vcpu === undefined &&
            props.memory === undefined &&
            props.memoryMib === undefined &&
            props.disk === undefined
              ? "lite"
              : undefined),
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          memoryMib: props.memoryMib,
          disk: props.disk,
          environmentVariables: Object.entries(env).map(([name, value]) => ({
            name,
            value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          })),
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      // Scaling/placement defaults mirror wrangler's container defaults
      // (`wrangler-dist/cli.js`) so an Alchemy container behaves like a
      // `wrangler deploy`d one without extra config:
      //   - max_instances: 20            (`container.max_instances ?? 20`)
      //   - instances: 0                 (wrangler forces 0 whenever
      //                                    max_instances is set, which we always
      //                                    do — pure scale-from-zero)
      //   - scheduling_policy: "default"
      // (wrangler also defaults `constraints.tiers` to `[1, 2]`, but the
      // distilled SDK models constraints as singular `tier`, not the `tiers`
      // array, so we leave constraints untouched — it's a minor placement hint
      // next to the scaling defaults.)
      // A maxInstances default of 1 (the previous value) silently serialised
      // every Durable Object instance through a single container slot, which is
      // the dominant cause of "containers are slow under load".
      const scalingDefaults = (props: AnyContainerApplicationProps) => ({
        instances: props.instances ?? 0,
        maxInstances: props.maxInstances ?? 20,
        schedulingPolicy: props.schedulingPolicy ?? "default",
        constraints: props.constraints ?? {},
      });

      const applicationConfigurationHash = Effect.fn(
        "applicationConfigurationHash",
      )(function* (
        scaling: ReturnType<typeof scalingDefaults>,
        affinities: ContainerApplication.Affinities | undefined,
        configuration: ContainerApplication.Configuration,
      ) {
        return yield* sha256Object({
          scaling,
          affinities: normalizeNulls(affinities),
          configuration,
        });
      });

      const maybeCreateRollout = Effect.fn(function* ({
        applicationId,
        configuration,
        rollout,
      }: {
        applicationId: string;
        configuration: ContainerApplication.Configuration;
        rollout: ContainerApplication.Rollout | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const strategy = rollout?.strategy ?? "immediate";
        const stepPercentage =
          strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* retryForContainerApplicationReadiness(
          "rollout",
          applicationId,
          Containers.createContainerApplicationRollout({
            accountId,
            applicationId,
            description:
              strategy === "immediate"
                ? "Immediate update"
                : "Progressive update",
            strategy: "rolling",
            kind: rollout?.kind ?? "full_auto",
            stepPercentage,
            targetConfiguration: configuration,
          }),
        );
      });

      const createApplication = Effect.fn(function* ({
        id,
        news,
        bindings,
        name,
        configuration,
        durableObjects,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        bindings: ResourceBinding<ContainerApplication["Binding"]>[];
        name: string;
        configuration: ContainerApplication.Configuration;
        durableObjects:
          | {
              namespaceId: string;
            }
          | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const describeError = (error: unknown) => {
          if (error instanceof Error) {
            return JSON.stringify(
              Object.fromEntries(
                Object.getOwnPropertyNames(error).map((key) => [
                  key,
                  (error as unknown as Record<string, unknown>)[key],
                ]),
              ),
              null,
              2,
            );
          }
          return String(error);
        };

        // Engine has cleared us via `read` (foreign-named applications are
        // surfaced as `Unowned`). Re-fetch the existing application to fold
        // it into the upsert path.
        const existingByName = yield* findApplicationByName(name);

        if (existingByName) {
          yield* Effect.logInfo(
            `Cloudflare Container create: adopting existing application ${name}`,
          );
          return yield* upsertApplication({
            id,
            news,
            bindings,
            existing: toAttributes(existingByName),
            durableObjects,
            session,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container create: creating application ${name}`,
        );
        yield* session.note(`Creating container application ${name}...`);
        const adoptExistingByName = Effect.gen(function* () {
          yield* Effect.logInfo(
            `Cloudflare Container create: application ${name} already exists, adopting`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" already exists but could not be found for adoption.`,
              ),
            );
          }
          return yield* upsertApplication({
            id,
            news,
            bindings,
            existing: toAttributes(existing),
            durableObjects,
            session,
          });
        });

        const application = yield* Containers.createContainerApplication({
          accountId,
          name,
          ...scalingDefaults(news),
          affinities: news.affinities,
          configuration,
          durableObjects,
        }).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", () =>
            durableObjects
              ? Effect.gen(function* () {
                  const existing = yield* findApplicationByNamespace(
                    durableObjects.namespaceId,
                  );
                  const recovery = resolveDurableObjectApplicationRecovery({
                    namespaceId: durableObjects.namespaceId,
                    expectedName: name,
                    existingName: existing?.name,
                  });
                  if (!recovery.canAdopt) {
                    return yield* Effect.fail(new Error(recovery.message));
                  }
                  if (!existing) {
                    return yield* Effect.fail(
                      new Error(
                        `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                      ),
                    );
                  }
                  return yield* upsertApplication({
                    id,
                    news,
                    bindings,
                    existing: toAttributes(existing),
                    durableObjects,
                    session,
                  });
                })
              : Effect.fail(
                  new Error(
                    "Durable Object namespace already has a container application. Set AdoptPolicy to adopt it.",
                  ),
                ),
          ),
          Effect.catchIf(
            (e) =>
              "message" in (e as any) &&
              String((e as any).message).includes("already exists"),
            () => adoptExistingByName,
          ),
          Effect.tapError((error) =>
            Effect.logError(
              `Cloudflare Container create error: ${describeError(error)}`,
            ),
          ),
        );

        return "applicationId" in application
          ? application
          : toAttributes(application);
      });

      const upsertApplication = Effect.fn(function* ({
        id,
        news,
        bindings,
        existing,
        durableObjects,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        bindings: ResourceBinding<ContainerApplication["Binding"]>[];
        existing: ContainerApplication["Attributes"];
        // The DO attachment to (re)create with if the "existing" application
        // turns out to be gone. Threaded through so the update→create fallback
        // below preserves the binding.
        durableObjects: { namespaceId: string } | undefined;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* Effect.logInfo(
          `Cloudflare Container update: preparing ${existing.applicationName}`,
        );
        const env = makeContainerEnv(news, accountId, bindings);
        const { imageRef, imageHash, dev, digest } =
          yield* resolveContainerImage(news, env);
        const deploymentImageRef = imageRef;
        const imageDigest = digest;
        const configuration = desiredConfiguration(
          news,
          env,
          deploymentImageRef,
        );
        const scaling = scalingDefaults(news);
        const configurationHash = yield* applicationConfigurationHash(
          scaling,
          news.affinities,
          configuration,
        );
        if (existing.hash?.configuration === configurationHash) {
          yield* Effect.logInfo(
            `Cloudflare Container update: ${existing.applicationName} has no effective changes`,
          );
          yield* session.note(
            `Container application ${existing.applicationName} is unchanged.`,
          );
          return {
            ...existing,
            configuration,
            hash: {
              image: imageHash,
              digest: imageDigest,
              configuration: configurationHash,
            },
            dev,
          };
        }

        yield* session.note(
          `Updating container application ${existing.applicationName}...`,
        );
        const application = yield* retryForContainerApplicationReadiness(
          "update",
          existing.applicationId,
          Containers.updateContainerApplication({
            accountId,
            applicationId: existing.applicationId,
            ...scaling,
            affinities: news.affinities,
            configuration,
          }),
        ).pipe(
          // The "existing" application was observed from an eventually-
          // consistent list/get but is actually gone — e.g. a stale row that
          // lingered after a replacement/DO-recreate delete, surfaced by
          // either the by-name or by-namespace lookup. Updating a ghost
          // exhausts the readiness window and then fails permanently with
          // `ContainerApplicationNotFound`. Instead, create it fresh so
          // reconcile converges regardless of the stale observation. By the
          // time the bounded readiness retry has elapsed, the deleted row has
          // fallen out of the eventually-consistent views, so this create
          // does not re-collide.
          Effect.catchTag("ContainerApplicationNotFound", () =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container update: ${existing.applicationName} no longer exists, creating fresh`,
              );
              return yield* Containers.createContainerApplication({
                accountId,
                name: existing.applicationName,
                ...scaling,
                affinities: news.affinities,
                configuration,
                durableObjects,
              });
            }),
          ),
        );
        const updated = toAttributes(application);
        if (!deepEqual(existing.configuration, configuration)) {
          yield* Effect.logInfo(
            `Cloudflare Container update: creating rollout for ${updated.applicationName}`,
          );
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration,
            rollout: news.rollout,
          });
        }
        return {
          ...updated,
          configuration,
          hash: {
            image: imageHash,
            digest: imageDigest,
            configuration: configurationHash,
          },
          dev,
        };
      });

      const getDurableObjects = (
        bindings: ResourceBinding<ContainerApplication["Binding"]>[],
      ) => {
        // A stale Worker namespace map can resolve a binding to an object
        // without an id. It does not request removing the live attachment.
        const dos = bindings.flatMap((b) =>
          b.data.durableObjects?.namespaceId ? [b.data.durableObjects] : [],
        );
        // A single DO namespace may appear in multiple bindings (e.g. when
        // a Container is referenced by several resources). Dedupe by namespaceId.
        const uniqueDos = dos.filter(
          (d, i, arr) =>
            arr.findIndex((other) => other.namespaceId === d.namespaceId) === i,
        );
        if (uniqueDos.length === 0) {
          return Effect.succeed(undefined);
        }
        if (uniqueDos.length === 1) {
          return Effect.succeed(uniqueDos[0]);
        }
        return Effect.die(
          new Error(
            `A Container can only be bound to one Durable Object namespace. Found ${uniqueDos.length} unique namespaces in bindings: ${uniqueDos.map((d) => d.namespaceId).join(", ")}`,
          ),
        );
      };

      return ContainerPlatform.Provider.of({
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({
          id,
          olds = {},
          news = {},
          output,
          newBindings,
          oldBindings,
        }) {
          if (!isResolved(news) || !isResolved(newBindings)) {
            return undefined;
          }
          const { accountId } = yield* yield* CloudflareEnvironment;

          const oldName =
            output?.applicationName ??
            (yield* createApplicationName(id, olds.name));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const name = news.name ?? oldName;

          if (
            (output?.accountId ?? accountId) !== accountId ||
            name !== oldName
          ) {
            return { action: "replace" } as const;
          }

          const hasDurableObjects =
            (yield* getDurableObjects(newBindings)) !== undefined;
          const hasUnresolvedAttachment =
            !hasDurableObjects &&
            newBindings.some(
              (binding) => binding.data.durableObjects !== undefined,
            );
          const hadDurableObjects =
            (yield* getDurableObjects(oldBindings)) !== undefined;
          if (
            !hasUnresolvedAttachment &&
            hasDurableObjects !== hadDurableObjects
          ) {
            return { action: "replace" } as const;
          }

          if (!output) {
            return undefined;
          }

          // A `dev:` applicationId means the resource only exists locally and
          // the real application has never been created. Promote it by forcing
          // an update so reconcile creates the live application.
          if (!isLiveId(output.applicationId)) {
            // Override stables to only include the accountId because the applicationId is going to change.
            return { action: "update", stables: ["accountId"] } as const;
          }

          const application = yield* Containers.getContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
          if (
            application &&
            (application.id !== output.applicationId ||
              application.name !== output.applicationName ||
              application.accountId !== output.accountId)
          ) {
            return { action: "replace" } as const;
          }

          const { imageRef, imageHash, dev } = yield* resolveContainerImage(
            news,
            makeContainerEnv(news, accountId, newBindings),
          );
          if (
            imageRef !== output.configuration.image ||
            imageHash !== output.hash?.image ||
            !deepEqual(dev, output.dev)
          ) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          bindings,
          output,
          session,
        }) {
          // Prefer the deployed name: regenerating would target a different
          // resource if the generator's output for this id ever drifts.
          const name =
            output?.applicationName ??
            (yield* createApplicationName(id, news.name));
          yield* Effect.logInfo(
            `Cloudflare Container reconcile: starting ${name}`,
          );
          const durableObjects = yield* getDurableObjects(bindings);
          const hasUnresolvedAttachment =
            durableObjects === undefined &&
            bindings.some(
              (binding) => binding.data.durableObjects !== undefined,
            );
          const { accountId } = yield* yield* CloudflareEnvironment;
          const env = makeContainerEnv(news, accountId, bindings);

          // Observe — re-fetch the cached application to confirm it still
          // exists. Cloudflare reports a deleted container application as
          // `ContainerApplicationNotFound`; we fall back to a name lookup
          // so we can recover from out-of-band deletes or partial state
          // persistence failures.
          let existing: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — skip the
          // cached-id fetch and fall through to the name lookup / create path
          // so we promote the local resource to a real application.
          if (output?.applicationId && isLiveId(output.applicationId)) {
            existing = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          if (!existing) {
            const found = yield* findApplicationByName(name);
            if (found) {
              existing = {
                ...toAttributes(found),
                hash: output?.hash,
              };
            }
          }

          // Only use cached attachment data after confirming the application
          // is missing. An observed live attachment outranks stale state.
          const recordedDurableObjects = existing
            ? existing.durableObjects
            : output?.accountId === accountId && isLiveId(output.applicationId)
              ? output.durableObjects
              : undefined;
          const durableObjectsForRecovery =
            durableObjects ??
            (hasUnresolvedAttachment && recordedDurableObjects?.namespaceId
              ? recordedDurableObjects
              : undefined);
          if (
            hasUnresolvedAttachment &&
            durableObjectsForRecovery === undefined
          ) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" has an unresolved Durable Object namespace and no recorded attachment. Reconcile its Worker first.`,
              ),
            );
          }
          const { imageRef, imageHash, dev, digest } =
            yield* resolveContainerImage(news, env);

          // The DO attachment is immutable, so a changed attachment
          // requires deleting and recreating the application. Adoption-by-namespace is preferred when an app
          // already owns the namespace.
          // An unresolved declaration is not an intentional removal.
          if (
            existing &&
            !hasUnresolvedAttachment &&
            !deepEqual(existing.durableObjects, durableObjects)
          ) {
            if (durableObjects) {
              const owner = yield* findApplicationByNamespace(
                durableObjects.namespaceId,
              );
              const recovery = resolveDurableObjectApplicationRecovery({
                namespaceId: durableObjects.namespaceId,
                expectedName: name,
                existingName: owner?.name,
              });
              if (recovery.canAdopt) {
                if (!owner) {
                  return yield* Effect.fail(
                    new Error(
                      `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                    ),
                  );
                }
                return yield* upsertApplication({
                  id,
                  news,
                  bindings,
                  existing: toAttributes(owner),
                  durableObjects,
                  session,
                });
              }
            }
            const deploymentImageRef = imageRef;
            const imageDigest = digest;
            const configuration = desiredConfiguration(
              news,
              env,
              deploymentImageRef,
            );
            const configurationHash = yield* applicationConfigurationHash(
              scalingDefaults(news),
              news.affinities,
              configuration,
            );
            yield* Effect.logInfo(
              `Cloudflare Container reconcile: recreating ${name} to attach durable object binding`,
            );
            yield* session.note(
              `Recreating container application ${name} with durable object binding...`,
            );
            yield* Containers.deleteContainerApplication({
              accountId: existing.accountId,
              applicationId: existing.applicationId,
            }).pipe(
              Effect.catchTag(
                "ContainerApplicationNotFound",
                () => Effect.void,
              ),
            );
            // Wait out the eventually-consistent `list` so the recreate below
            // doesn't re-adopt the just-deleted application and then try to
            // update a now-gone id (see `waitForApplicationDeleted`).
            yield* waitForApplicationDeleted(name, existing.applicationId);
            const result = yield* createApplication({
              id,
              news,
              bindings,
              name,
              configuration,
              durableObjects,
              session,
            });
            return {
              ...("applicationId" in result ? result : toAttributes(result)),
              hash: {
                image: imageHash,
                digest: imageDigest,
                configuration: configurationHash,
              },
              dev,
            };
          }

          // Sync — application exists with correct DO attachment. Apply
          // the desired configuration (image + scheduling + secrets, etc.)
          // through the upsert path, creating a rollout when configuration drifted.
          if (existing) {
            return yield* upsertApplication({
              id,
              news,
              bindings,
              existing,
              // Keep the live attachment through the ghost-recreate fallback
              // when the desired value is unresolved.
              durableObjects: durableObjectsForRecovery,
              session,
            });
          }

          // Ensure — no application exists. The image resource is already ready. `createApplication` itself tolerates concurrent
          // creates by adopting an existing application with the same
          // name or namespace.
          const configuration = desiredConfiguration(news, env, imageRef);
          const configurationHash = yield* applicationConfigurationHash(
            scalingDefaults(news),
            news.affinities,
            configuration,
          );
          const result = yield* createApplication({
            id,
            news,
            bindings,
            name,
            configuration,
            durableObjects: durableObjectsForRecovery,
            session,
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: {
              image: imageHash,
              digest: digest,
              configuration: configurationHash,
            },
            dev,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A `dev:` applicationId only exists locally — there is no live
          // application to delete on Cloudflare.
          if (!isLiveId(output.applicationId)) return;
          yield* Effect.logInfo(
            `Cloudflare Container delete: deleting ${output.applicationName}`,
          );
          yield* Containers.deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const readByName = (name: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container read: looking up ${name}`,
              );
              const existing = yield* findApplicationByName(name);
              if (!existing) {
                yield* Effect.logInfo(
                  `Cloudflare Container read: ${name} not found`,
                );
                return undefined;
              }
              return {
                ...toAttributes(existing),
                hash: output?.hash,
                // The dev image is a local build-context reference that the
                // API can't return — preserve the persisted one so a refresh
                // doesn't wipe it (which would break a later `alchemy dev`).
                dev: output?.dev,
              };
            });

          let attrs: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — look the
          // application up by its (deterministic) name instead of hitting the
          // API with a fake id.
          if (output?.applicationId && !isLiveId(output.applicationId)) {
            return yield* readByName(output.applicationName);
          }
          if (output?.applicationId) {
            yield* Effect.logInfo(
              `Cloudflare Container read: checking ${output.applicationName}`,
            );
            attrs = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
                dev: output.dev,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                readByName(output.applicationName),
              ),
            );
            // If we matched by id from prior state, treat as owned.
            return attrs;
          }

          const name = yield* createApplicationName(id, olds?.name);
          attrs = yield* readByName(name);
          if (!attrs) return undefined;
          // Generated names identify this instance by its random suffix.
          // Explicit names alone do not establish ownership.
          return olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Account-scoped collection. `listContainerApplications` returns
            // the full application objects in one (non-paginated) response, so
            // each item already carries the complete `read` attributes shape —
            // no per-item hydration is required.
            return yield* Containers.listContainerApplications({
              accountId,
            }).pipe(
              Effect.map((apps) => apps.map((app) => toAttributes(app))),
              // Accounts without the containers product reject the route; treat
              // a non-entitled account as an empty collection rather than an
              // error.
              Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
            );
          }),
        tail: ({ output }) =>
          telemetry.tailStream({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
            options,
          }),
      });
    }),
  );

const containerFilters = (applicationId: string): TelemetryFilter[] => [
  {
    key: "$metadata.type",
    operation: "eq",
    type: "string",
    value: "cf-container",
  },
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: applicationId,
  },
];

const resolveDurableObjectApplicationRecovery = ({
  namespaceId,
  expectedName,
  existingName,
}: {
  namespaceId: string;
  expectedName: string;
  existingName: string | undefined;
}) => {
  if (!existingName) {
    return {
      canAdopt: false as const,
      message: `Container application for Durable Object namespace "${namespaceId}" already exists but could not be found for adoption.`,
    };
  }
  if (existingName !== expectedName) {
    return {
      canAdopt: false as const,
      message: `Existing container application "${existingName}" is already attached to Durable Object namespace "${namespaceId}". Use that application name to adopt it.`,
    };
  }
  return {
    canAdopt: true as const,
  };
};

// Cap each delay at 3s so the readiness window is ~30s over 10 attempts; an
// uncapped `Schedule.exponential(150)` reaches a ~76s single delay by the 10th
// retry (~150s total), which both blows test budgets and needlessly stalls the
// update→create fallback when the target is genuinely gone.
const containerApplicationReadinessSchedule = Schedule.max([
  Schedule.min([Schedule.exponential(150), Schedule.spaced("3 seconds")]),
  Schedule.recurs(10),
]);

const isContainerApplicationNotFound = (
  error: unknown,
): error is Containers.ContainerApplicationNotFound =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ContainerApplicationNotFound";

export const retryForContainerApplicationReadiness = <A, E, R>(
  operation: string,
  applicationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      isContainerApplicationNotFound(error)
        ? Effect.logDebug(
            `Cloudflare Container ${operation}: application ${applicationId} not found yet, retrying`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: isContainerApplicationNotFound,
      schedule: containerApplicationReadinessSchedule,
    }),
  );

const toAttributes = (
  application:
    | Containers.CreateContainerApplicationResponse
    | Containers.UpdateContainerApplicationResponse
    | Containers.GetContainerApplicationResponse
    | Containers.ListContainerApplicationsResponse[number],
): ContainerApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  schedulingPolicy: application.schedulingPolicy,
  instances: application.instances,
  maxInstances: application.maxInstances,
  constraints: normalizeNulls(
    application.constraints as ContainerApplication.Constraints | undefined,
  ),
  affinities: normalizeNulls(
    application.affinities as ContainerApplication.Affinities | undefined,
  ),
  configuration: normalizeNulls(
    application.configuration as ContainerApplication.Configuration,
  ),
  durableObjects: normalizeNulls(application.durableObjects) as
    | { namespaceId: string }
    | undefined,
  createdAt: application.createdAt,
  version: application.version,
  dev: undefined,
});
