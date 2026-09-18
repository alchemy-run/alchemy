import * as Cloudflare from "@/Cloudflare";
import * as Docker from "@/Docker";
import * as Effect from "effect/Effect";
import * as Output from "@/Output.ts";

export const descriptorApplications = (context: string, includeFirst = true) =>
  Effect.gen(function* () {
    const image = Docker.Image({ context, options: ["--provenance=false"] });
    const first = includeFirst
      ? yield* Cloudflare.Container("DescriptorFirst", { image }).Application
      : undefined;
    const second = yield* Cloudflare.Container("DescriptorSecond", { image })
      .Application;
    const remote = yield* Cloudflare.Container("DescriptorRemote", {
      image: Docker.RemoteImage({
        source: second.configuration.pipe(
          Output.map((configuration) => configuration.image),
        ),
        publish: {
          repository: yield* Cloudflare.containerRepository(
            "alchemy-descriptor-mirror",
          ),
        },
      }),
    }).Application;
    return { first, second, remote };
  });

export const publicationApplications = (contexts: {
  shared: string;
  other: string;
  changed: string;
}) =>
  Effect.gen(function* () {
    const image = yield* Docker.Image("SharedImage", {
      build: { context: contexts.shared, platform: "linux/amd64" },
      publish: {
        repository: yield* Cloudflare.containerRepository(
          "alchemy-publication-sharing",
        ),
      },
    });
    const first = yield* Cloudflare.Container("PublicationFirst", {
      image: image.ref,
      env: { SLOT: "first" },
      maxInstances: 2,
    }).Application;
    const second = yield* Cloudflare.Container("PublicationSecond", {
      image: image.ref,
      env: { SLOT: "second" },
      maxInstances: 3,
    }).Application;
    const other = yield* Cloudflare.Container("PublicationOtherContext", {
      context: contexts.other,
      maxInstances: 2,
    }).Application;
    const changed = yield* Cloudflare.Container("PublicationChangedContent", {
      context: contexts.changed,
      maxInstances: 2,
    }).Application;
    return { first, second, other, changed };
  });

export const sharedApplication = (context: string, repository?: string) =>
  Effect.gen(function* () {
    const image = repository
      ? yield* Docker.Image("SharedImage", {
          build: { context, platform: "linux/amd64" },
          publish: {
            repository: yield* Cloudflare.containerRepository(repository),
          },
        })
      : undefined;
    const app = yield* Cloudflare.Container("SharedPublication", {
      ...(image ? { image: image.ref } : { context }),
      maxInstances: 2,
    }).Application;
    return { app };
  });

export const historyApplications = (converge = false) =>
  Effect.gen(function* () {
    const target = converge
      ? yield* Cloudflare.Container("HistoryTarget", {
          image: "docker.io/alpine:3.19",
        }).Application
      : undefined;
    const image = target?.configuration.pipe(
      Output.map((configuration) => configuration.image),
    );
    const first = yield* Cloudflare.Container("HistoryFirst", {
      image: image ?? "alpine:3.19",
    }).Application;
    const second = yield* Cloudflare.Container("HistorySecond", {
      image: image ?? "alpine:3.20",
    }).Application;
    return { first, second, target };
  });

export const recoveryApplications = (
  delay: number,
  includeSecond = false,
  seed = "",
) =>
  Effect.gen(function* () {
    const props = {
      dockerfile: {
        content: `FROM alpine:3.19\nLABEL test.run="${seed}"\nRUN sleep ${delay}\nCMD ["sleep", "3600"]\n`,
      },
      maxInstances: 2,
    };
    const first = yield* Cloudflare.Container("RecoveryFirst", props)
      .Application;
    const second = includeSecond
      ? yield* Cloudflare.Container("RecoverySecond", props).Application
      : undefined;
    return { first, second };
  });
