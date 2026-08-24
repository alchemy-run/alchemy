import { AlchemyContextLive } from "@/AlchemyContext.ts";
import { AlchemyControl, layer } from "@/AlchemyControl/index.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileStoreLive } from "@/Auth/Profile.ts";
import { inMemoryState } from "@/State/InMemoryState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import { selectCliServices } from "@/Cli/selectCli.ts";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const resource = {
  resourceType: "test:resource",
  namespace: undefined,
  fqn: "resource",
  logicalId: "resource",
  instanceId: "instance-resource",
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: {},
  attr: { value: 1 },
} as ResourceState;

const controlLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      inMemoryState(
        { app: { dev: { resource } } },
        { app: { dev: { url: "https://example.com" } } },
      ),
      Layer.provide(ProfileStoreLive, PlatformServices),
      Layer.provide(CredentialsStoreLive, PlatformServices),
      Layer.provide(AlchemyContextLive, PlatformServices),
      Layer.succeed(ArtifactStore, createArtifactStore()),
      FetchHttpClient.layer,
      Layer.provideMerge(selectCliServices(), CliKit.layer()),
      PlatformServices,
    ),
  ),
);

describe("AlchemyControl", () => {
  it.effect("exposes the complete command router", () =>
    Effect.gen(function* () {
      const control = yield* AlchemyControl;
      expect(Object.keys(control).sort()).toEqual([
        "drift",
        "logs",
        "profile",
        "provider",
        "stack",
        "state",
        "unsafe",
      ]);
      expect(Object.keys(control.stack).sort()).toEqual([
        "deploy",
        "destroy",
        "dev",
        "plan",
      ]);
      expect(Object.keys(control.drift).sort()).toEqual(["inspect", "repair"]);
      expect(Object.keys(control.logs).sort()).toEqual([
        "entries",
        "resources",
        "tail",
      ]);
      expect(Object.keys(control.profile).sort()).toEqual([
        "configure",
        "configureForm",
        "create",
        "current",
        "delete",
        "get",
        "list",
        "providers",
        "refresh",
        "removeProvider",
        "rename",
      ]);
      expect(Object.keys(control.state).sort()).toEqual([
        "changes",
        "delete",
        "info",
        "list",
        "read",
      ]);
      expect(Object.keys(control.provider).sort()).toEqual([
        "aws",
        "checkEnvironment",
        "cloudflare",
      ]);
      expect(Object.keys(control.provider.aws).sort()).toEqual([
        "bootstrap",
        "teardown",
      ]);
      expect(Object.keys(control.provider.cloudflare).sort()).toEqual([
        "bootstrap",
        "stateLogs",
        "teardown",
        "token",
      ]);
      expect(Object.keys(control.provider.cloudflare.stateLogs).sort()).toEqual(
        ["entries", "tail"],
      );
      expect(Object.keys(control.provider.cloudflare.token).sort()).toEqual([
        "catalog",
        "create",
        "plan",
      ]);
      expect(Object.keys(control.unsafe.nuke).sort()).toEqual([
        "execute",
        "scan",
      ]);
    }).pipe(Effect.provide(controlLayer)),
  );

  it.effect("queries state as structured data", () =>
    Effect.gen(function* () {
      const control = yield* AlchemyControl;

      expect(yield* control.state.list({})).toEqual(["app/"]);
      expect(
        yield* control.state.list({ path: "app/dev", recursive: true }),
      ).toEqual(["app/dev/resource", "app/dev/output"]);

      expect(yield* control.state.read({ path: "app/dev/output" })).toEqual([
        {
          path: "app/dev/output",
          kind: "output",
          value: { url: "https://example.com" },
        },
      ]);
    }).pipe(Effect.provide(controlLayer)),
  );

  it.effect("publishes structured mutation events", () =>
    Effect.gen(function* () {
      const control = yield* AlchemyControl;
      const deleted = yield* control.state.delete({
        path: "app/dev",
        recursive: true,
      });
      const event = yield* control.state.changes.pipe(
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );

      expect(deleted).toEqual({
        _tag: "StateDeleted",
        path: "app/dev",
        deleted: ["app/dev/resource", "app/dev/output"],
      });
      expect(event).toEqual(deleted);
      expect(yield* control.state.list({ path: "app" })).toEqual([]);
    }).pipe(Effect.provide(controlLayer)),
  );
});
