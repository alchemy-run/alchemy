import * as Archil from "@alchemy.run/archil";
import * as AWS from "@alchemy.run/aws";
import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Process from "@distilled.cloud/archil/Process";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import DerivedApi, { PROBE_MARKER } from "./fixtures/program/derived.ts";

const providers = Layer.mergeAll(Archil.providers(), AWS.providers());
const { test } = Test.make({ providers });

const Repository = AWS.ECR.Repository("ArchilPush", {});

/** ECR registry credentials Archil (and the local build) can push and pull with. */
const ecrCredentials = Effect.gen(function* () {
  const { authorizationData } = yield* ecr.getAuthorizationToken({});
  const data = authorizationData?.[0];
  const token = data?.authorizationToken;
  const decoded = atob(
    token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
  );
  return {
    server: new URL(data?.proxyEndpoint ?? "https://invalid").host,
    username: "AWS",
    password: Redacted.make(decoded.slice(decoded.indexOf(":") + 1)),
  };
});

const getText = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) => r.text),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
    );
  });

test.provider.skipIf(!!process.env.FAST)(
  "a Dockerfile image and a program sandbox's derived image are built, pushed, and booted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // The repository first: its URI is where both images are pushed.
      const repository = yield* stack.deploy(Repository);
      const credentials = yield* ecrCredentials;
      const push = { repository: repository.repositoryUri, credentials };
      const ambient = yield* ConfigProvider.ConfigProvider;

      const { built, box, api } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repository;
          const built = yield* Archil.Image("Built", {
            dockerfile: Dockerfile.inline`
FROM alpine:3.20
RUN echo built-by-alchemy > /etc/alchemy-built
`,
            push,
          });
          const box = yield* Archil.Sandbox("FromBuilt", {
            image: built.imageId,
            idleTtlSeconds: 120,
          });
          const api = yield* DerivedApi;
          return { built, box, api };
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({
                ARCHIL_PUSH_REPOSITORY: repository.repositoryUri,
                ARCHIL_PUSH_SERVER: credentials.server,
                ARCHIL_PUSH_PASSWORD: Redacted.value(credentials.password),
              }),
              ambient,
            ),
          ),
        ),
      );

      // Archil pulled the pushed build: it's private, and boots with the file.
      expect(built.source.startsWith(repository.repositoryUri)).toBe(true);
      expect(built.private).toBe(true);
      const cat = yield* Process.exec(box.sandboxId, "cat /etc/alchemy-built");
      expect(cat.stdout.trim()).toBe("built-by-alchemy");

      // The program's sandbox boots the derived image with the install line.
      expect(api.derivedImage?.imageId).toMatch(/^[0-9a-f]{64}$/);
      expect(yield* getText(`${api.url}/`)).toBe(PROBE_MARKER);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:archil", "provider:archil:image", "provider:aws", "live"],
    timeout: 900_000,
  },
);
