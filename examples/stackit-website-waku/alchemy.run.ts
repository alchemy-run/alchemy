import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// The registry's own API doesn't take STACKIT credentials: this is a Harbor
// user's CLI secret, from the user profile in the registry's web UI.
const harbor = {
  username: Config.String("HARBOR_USERNAME"),
  secret: Config.Redacted("HARBOR_CLI_SECRET"),
};

// A STACKIT Function runs an OCI image: where the site's image goes, and the
// read-only credential the Function pulls it with.
const Registry = Effect.gen(function* () {
  const images = yield* Stackit.ContainerRegistry.Project("Images", {
    // Harbor refuses to delete a project that still holds images.
    forceDestroy: true,
    harborCredentials: harbor,
  });
  const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
    project: images.name,
    registryUrl: images.url,
    credentials: harbor,
    permissions: [
      { resource: "repository", action: "pull" },
      { resource: "repository", action: "push" },
    ],
  });
  const puller = yield* Stackit.ContainerRegistry.RobotAccount("Puller", {
    project: images.name,
    registryUrl: images.url,
    credentials: harbor,
    permissions: [{ resource: "repository", action: "pull" }],
  });
  const pullCredential = yield* Stackit.Functions.PullCredential("PullCredential", {
    address: images.registryHost,
    username: puller.robotName,
    password: puller.secret,
  });
  return {
    registry: {
      repository: Output.interpolate`${images.imagePrefix}/web`,
      username: pusher.robotName,
      password: pusher.secret,
    },
    pullCredential: pullCredential.pullCredentialId,
  };
});

export default Alchemy.Stack(
  "StackitWebsiteWakuExample",
  {
    providers: Stackit.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // `alchemy dev` runs the framework's own dev server, which needs no image.
    const { dev } = yield* Alchemy.AlchemyContext;
    const hosting = dev ? {} : yield* Registry;

    const site = yield* Stackit.Website.Waku("WakuSite", {
      ...hosting,
      // Only hash the files that affect the build, so unchanged sources
      // skip the Waku build (and the deploy) entirely.
      memo: {
        include: ["src/**", "public/**", "package.json", "waku.config.ts"],
      },
      env: {
        GREETING: "Hello from Waku on STACKIT!",
      },
    });

    return {
      url: site.url,
      serverUrl: site.serverUrl,
      projectId: site.distribution?.projectId,
      distributionId: site.distribution?.distributionId,
      hostname: site.distribution?.hostname,
      functionId: site.server?.functionId,
    };
  }),
);
