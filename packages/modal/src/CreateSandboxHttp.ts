import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { CreateSandbox, type SandboxesClient, type SandboxUsageGroup } from "./CreateSandbox.ts";
import type { Image } from "./Image.ts";
import { timestampOf } from "./internal.ts";
import { type RuntimeOwner, RuntimeOwnerOf, runtimeTags } from "./RuntimeOwner.ts";
import type { Sandbox } from "./Sandbox.ts";
import {
  createPersistentSandbox,
  createSandbox,
  listSandboxes,
  persistentSandboxHandle,
  restoreSandbox,
  SandboxOps,
  sandboxFromName,
  sandboxHandle,
  type SandboxTarget,
} from "./SandboxClient.ts";

const HOUR_MS = 3_600_000;

/** A time rounded to an hour boundary, as Modal's usage query wants it. */
const hourOf = (value: Date | string | number, round: (n: number) => number): string =>
  timestampOf(round(new Date(value).getTime() / HOUR_MS) * HOUR_MS);

/** A sandboxes client over a target resolved per call. */
export const makeSandboxesClient = (
  target: Effect.Effect<SandboxTarget>,
  ops: SandboxOps,
  owner: Effect.Effect<RuntimeOwner | undefined> = Effect.undefined,
): SandboxesClient => ({
  appId: Effect.map(target, (t) => t.appId),
  create: (options) =>
    Effect.flatMap(Effect.all([target, owner]), ([t, o]) =>
      createSandbox(ops, t, {
        ...options,
        // The owner's tags win over a user tag of the same key.
        tags: o === undefined ? options?.tags : { ...options?.tags, ...runtimeTags(o) },
      }),
    ),
  fromName: (name) => Effect.flatMap(target, (t) => sandboxFromName(ops, t, name)),
  fromId: (sandboxId) => Effect.map(target, (t) => sandboxHandle(ops, sandboxId, t)),
  list: (options) => Effect.flatMap(target, (t) => listSandboxes(ops, t, options)),
  usage: (query) =>
    Effect.gen(function* () {
      const t = yield* target;
      const groups: Array<SandboxUsageGroup> = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 100; page++) {
        const response = yield* ops.usage({
          appId: t.appId,
          // Modal reports usage by whole hours.
          since: hourOf(query.since, Math.floor),
          until: query.until === undefined ? undefined : hourOf(query.until, Math.ceil),
          groupByTags: query.groupByTags ? [...query.groupByTags] : undefined,
          tags: query.tags,
          pageToken,
        });
        for (const group of response.groups ?? []) {
          groups.push({
            tags: Object.fromEntries(
              Object.entries(group.tags ?? {}).map(([key, value]) => [key, value?.value ?? ""]),
            ),
            cost: group.cost ?? 0,
            costByResource: Object.fromEntries(
              Object.entries(group.costByResource ?? {}).map(([key, value]) => [key, value ?? 0]),
            ),
          });
        }
        pageToken = response.nextPageToken || undefined;
        if (pageToken === undefined) break;
      }
      return groups;
    }),
  createPersistent: (options) =>
    Effect.flatMap(target, (t) => createPersistentSandbox(ops, t, options)),
  persistent: (box) =>
    Effect.map(target, (t) =>
      persistentSandboxHandle(ops, typeof box === "string" ? box : box.persistentSandboxId, t),
    ),
  restore: (snapshot, options) =>
    Effect.gen(function* () {
      const restored = yield* restoreSandbox(ops, yield* target, snapshot, options);
      const o = yield* owner;
      if (o !== undefined) yield* restored.setTags(runtimeTags(o));
      return restored;
    }),
});

const isImage = (target: App | Image | Sandbox): target is Image => target.Type === "Modal.Image";
const isProgram = (target: App | Image | Sandbox): target is Sandbox =>
  target.Type === "Modal.Sandbox";

/**
 * {@link CreateSandbox} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the App's environment.
 *
 * @layer
 * @product Sandbox
 * @provides Modal.CreateSandbox
 */
export const CreateSandboxHttp = Layer.effect(
  CreateSandbox,
  makeModalBinding({
    tag: "Modal.CreateSandbox",
    operations: SandboxOps,
    role: "contributor",
    make: Effect.fn(function* (resource: App | Image | Sandbox, ops) {
      const owner = yield* RuntimeOwnerOf();
      if (isProgram(resource)) {
        const imageId = yield* resource.imageId;
        const appId = yield* resource.appId;
        const appName = yield* resource.appName;
        const environment = yield* resource.environment;
        const secretId = yield* resource.secretId;
        const command = yield* resource.command;
        const port = yield* resource.port;
        const mounts = yield* resource.mounts;
        const target = Effect.all({
          imageId,
          appId,
          appName,
          environment,
          secretId,
          command,
          port,
          mounts,
        }).pipe(
          Effect.map((t): SandboxTarget => ({
            imageId: t.imageId,
            appId: t.appId,
            appName: t.appName,
            environment: t.environment,
            program: { secretId: t.secretId, command: t.command, port: t.port, mounts: t.mounts },
          })),
        );
        return makeSandboxesClient(target, ops, owner);
      }
      if (isImage(resource)) {
        const imageId = yield* resource.imageId;
        const appId = yield* resource.appId;
        const appName = yield* resource.appName;
        const environment = yield* resource.environment;
        const target = Effect.all({ imageId, appId, appName, environment }).pipe(
          Effect.map((t): SandboxTarget => t),
        );
        return makeSandboxesClient(target, ops, owner);
      }
      const appId = yield* resource.appId;
      const appName = yield* resource.name;
      const environment = yield* resource.environment;
      const target = Effect.all({ appId, appName, environment }).pipe(
        Effect.map((t): SandboxTarget => t),
      );
      return makeSandboxesClient(target, ops, owner);
    }),
  }),
);
