import { Image, ImageProvider, type ImageProps } from "@/AWS/ECR/Image.ts";
import { hashDockerBuildInputs } from "@/Docker/BuildHash.ts";
import { DockerLive } from "@/Docker/Docker.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";

// Exercise the real provider and filesystem hash without building an image or
// contacting ECR. An absolute build path is not part of the image's identity.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ecr-image-diff-" });
  const context = path.join(root, "original");
  const relocated = path.join(root, "relocated");
  yield* fs.makeDirectory(context);
  yield* fs.writeFileString(
    path.join(context, "Dockerfile"),
    "FROM scratch\nCOPY payload /payload\n",
  );
  yield* fs.writeFileString(path.join(context, "payload"), "original\n");
  yield* fs.copy(context, relocated);
  const imageTag = yield* hashDockerBuildInputs(
    { context, dockerfile: "Dockerfile", platform: "linux/amd64" },
    "all",
  );
  const repositoryUri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/app";
  const output: Image["Attributes"] = {
    imageTag,
    repositoryUri,
    repositoryName: "app",
    imageUri: `${repositoryUri}:${imageTag}`,
    digest: "sha256:existing-image",
    ownsRepository: false,
  };
  const provider = yield* Provider.Provider<Image>(Image.Type);
  const diff = provider.diff!;
  const olds: ImageProps = { context, repositoryUri };
  return {
    context,
    relocated,
    output,
    diff: (
      news: ImageProps,
      previous: ImageProps = olds,
      observed: Image["Attributes"] | undefined = output,
    ) =>
      diff({
        id: "Image",
        fqn: "Image",
        instanceId: "image-diff",
        olds: previous,
        news,
        output: observed,
        oldBindings: [],
        newBindings: [],
      }),
  };
});

const services = ImageProvider().pipe(
  Layer.provide(DockerLive),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(
    Layer.mergeAll(
      fromCredentials(
        { accessKeyId: "test-key", secretAccessKey: "test-secret" },
        "us-east-1",
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die(new Error("Image diff must not contact AWS")),
        ),
      ),
      Layer.succeed(Stack, {
        name: "image-diff",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Layer.succeed(Stage, "test"),
    ),
  ),
);

describe("ECR image content identity", () => {
  it.effect("does not update when identical build inputs move", () =>
    Effect.gen(function* () {
      const { diff, relocated, output } = yield* fixture;
      expect(
        yield* diff({
          context: relocated,
          repositoryUri: output.repositoryUri,
        }),
      ).toEqual({ action: "noop" });
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect("updates when content changes at the same path", () =>
    Effect.gen(function* () {
      const { diff, context, output } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(context, "payload"), "changed\n");
      expect(
        yield* diff({ context, repositoryUri: output.repositoryUri }),
      ).toEqual({ action: "update" });
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect(
    "updates when the repository changes without changing content",
    () =>
      Effect.gen(function* () {
        const { diff, context, output } = yield* fixture;
        expect(
          yield* diff({
            context,
            repositoryUri: `${output.repositoryUri}-other`,
          }),
        ).toEqual({ action: "update" });
      }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect(
    "does not skip transitions between managed and external repositories",
    () =>
      Effect.gen(function* () {
        const { diff, context, output } = yield* fixture;
        expect(yield* diff({ context })).toEqual({ action: "update" });
        expect(
          yield* diff(
            { context, repositoryUri: output.repositoryUri },
            { context },
            { ...output, ownsRepository: true },
          ),
        ).toEqual({ action: "update" });
      }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect("includes platform and build arguments in the decision", () =>
    Effect.gen(function* () {
      const { diff, context, output } = yield* fixture;
      for (const options of [
        { platform: "linux/arm64" },
        { buildArgs: { MODE: "production" } },
      ]) {
        expect(
          yield* diff({
            context,
            repositoryUri: output.repositoryUri,
            ...options,
          }),
        ).toEqual({ action: "update" });
      }
    }).pipe(Effect.provide(services), Effect.scoped),
  );
});
