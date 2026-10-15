import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileStoreLive } from "@/Auth/Profile.ts";
import { GcpAuth } from "@/GCP/AuthProvider.ts";
import { Credentials, fromAuthProvider } from "@/GCP/Credentials.ts";

it.effect(
  "credentials resolve with the ConfigProvider the layer was built under",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-gcp-" });
      const previous = process.env.ALCHEMY_HOME;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.ALCHEMY_HOME = home;
        }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ALCHEMY_HOME;
            else process.env.ALCHEMY_HOME = previous;
          }),
      );
      const context = yield* Layer.build(
        fromAuthProvider().pipe(
          Layer.provideMerge(GcpAuth),
          Layer.provideMerge(ProfileStoreLive),
          Layer.provideMerge(CredentialsStoreLive),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                GOOGLE_ACCESS_TOKEN: "layer-token",
                GOOGLE_PROJECT_ID: "layer-project",
              }),
            ),
          ),
        ),
      );
      const credentials = yield* Effect.flatten(Credentials).pipe(
        Effect.provideContext(context),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      );
      expect(Redacted.value(credentials.accessToken)).toBe("layer-token");
      expect(credentials.project).toBe("layer-project");
    }).pipe(
      Effect.scoped,
      Effect.provideService(AuthProviders, {}),
      Effect.provide(NodeServices.layer),
    ),
  { tags: ["unit", "provider:gcp", "local"], exclusive: true },
);
