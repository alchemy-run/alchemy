import * as Coolify from "@distilled.cloud/coolify";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { deployAndWait } from "./internal/deploy.ts";
import { hashOf } from "./internal/hash.ts";
import { isGeneratedName, looksGenerated, resolveName } from "./internal/naming.ts";
import { syncTags } from "./internal/tags.ts";
import type { Providers } from "./Providers.ts";

/**
 * Inline Dockerfile content. Structurally the same as
 * `@alchemy.run/docker/Dockerfile`'s `InlineDockerfile`, so
 * `Dockerfile.inline\`…\`` works here without a dependency on that package.
 */
export interface InlineDockerfile {
  readonly content: string;
}

/** Build an application from a public Git repository. */
export interface GitSource {
  /** Repository URL, e.g. `https://github.com/coollabsio/coolify-examples`. */
  repository: string;
  /** Branch to build. @default "main" */
  branch?: string;
  /** Pin a commit instead of the branch head. */
  commit?: string;
  /**
   * How Coolify builds the repository.
   * @default "nixpacks"
   */
  buildPack?: "nixpacks" | "railpack" | "static" | "dockerfile";
  /** Directory inside the repository to build from. @default "/" */
  baseDirectory?: string;
  /** Output directory served by the `static` build pack. */
  publishDirectory?: string;
  /** Dockerfile path inside the repository, for the `dockerfile` build pack. */
  dockerfileLocation?: string;
  /** Override the install command Nixpacks or Railpack detects. */
  installCommand?: string;
  /** Override the build command Nixpacks or Railpack detects. */
  buildCommand?: string;
  /** Override the start command Nixpacks or Railpack detects. */
  startCommand?: string;
}

/** Container health check Coolify's proxy uses before routing traffic. */
export interface HealthCheck {
  /** @default true when any other field is set */
  enabled?: boolean;
  /** HTTP path to probe. @default "/" */
  path?: string;
  /** Port to probe. Defaults to the first exposed port. */
  port?: number;
}

/** Container resource limits, in Docker's own units. */
export interface Limits {
  /** Memory limit, e.g. `"512m"` or `"1g"`. `"0"` means unlimited. */
  memory?: string;
  /** CPU limit, e.g. `"0.5"` or `"2"`. `"0"` means unlimited. */
  cpus?: string;
}

export interface ApplicationProps {
  /**
   * UUID of the project, usually `project.projectUuid`. Changing it
   * replaces the application.
   */
  project: string;
  /**
   * UUID of the environment to deploy into, usually
   * `environment.environmentUuid`. Set this or {@link environmentName}.
   * Changing it replaces the application.
   */
  environment?: string;
  /**
   * Name of the environment to deploy into, e.g. `"production"`, the
   * environment every project starts with. Set this or {@link environment}.
   * Changing it replaces the application.
   */
  environmentName?: string;
  /**
   * UUID of the server that runs the application. For a self-hosted
   * instance this is often the `localhost` server Coolify registers for
   * itself; only a team admin's token may deploy there (others get
   * `CoolifyHostRequiresAdmin`). Changing it replaces the application.
   */
  server: string;
  /**
   * UUID of the Docker network (destination) on the server. Only needed
   * when the server has more than one. Changing it replaces the application.
   */
  destination?: string;
  /**
   * Application name shown in the dashboard. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Updates in place.
   */
  name?: string;
  /** Free-form description. Updates in place. */
  description?: string;
  /**
   * A prebuilt image to run, e.g. `ghcr.io/acme/api@sha256:…` or
   * `nginx:1.27-alpine`. Coolify pulls a tag again on each deploy, so pin a
   * digest for repeatable deploys. Set exactly one of `image`,
   * `dockerfile` or `git`; switching between them replaces the
   * application.
   */
  image?: string;
  /**
   * A Dockerfile Coolify builds on the server: a path relative to where the
   * deploy runs, or inline content (`Dockerfile.inline` from
   * `@alchemy.run/docker/Dockerfile`, or `{ content }`).
   *
   * Coolify builds it in an empty context, so `COPY` and `ADD` of local
   * files don't work. Use `git` to build a repository, or build the image
   * yourself and pass `image`.
   */
  dockerfile?: string | InlineDockerfile;
  /** Build from a public Git repository with Nixpacks, Railpack, a static server or its Dockerfile. */
  git?: GitSource;
  /**
   * Container ports the proxy routes to. The first one serves the
   * application's domains.
   */
  ports?: number[];
  /**
   * URLs that serve the application, e.g. `["https://api.example.com"]`.
   * Point their DNS at the server; Coolify's proxy issues the
   * certificates. When omitted, Coolify generates a domain from the
   * server's wildcard domain (or sslip.io).
   */
  domains?: string[];
  /**
   * Environment variables, available at build and run time. Wrap secrets
   * in `Redacted.make(...)` (or pass a `Redacted` output) so they are never
   * logged. Values never enter state: only a hash is kept. Changing a value
   * redeploys the application.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /** Health check the proxy waits for before routing traffic. */
  healthCheck?: HealthCheck;
  /** CPU and memory limits. */
  limits?: Limits;
  /**
   * Coolify tags. Tags are team-wide names: `POST /deploy?tag=` deploys
   * every resource with the tag.
   */
  tags?: string[];
}

export type Application = Resource<
  "Coolify.Application",
  ApplicationProps,
  {
    /** Application UUID. */
    applicationUuid: string;
    /** Application name. */
    name: string;
    /** UUID of the project the application belongs to. */
    projectUuid: string;
    /** UUID of the server it runs on. */
    serverUuid: string;
    /** Which source the application is built from. */
    source: "image" | "dockerfile" | "git";
    /** URLs that serve the application. */
    domains: string[];
    /** The first of {@link domains}, if any. */
    url: string | undefined;
    /** Container status at the end of the deploy, e.g. `running:healthy`. */
    status: string;
    /** UUID of the deployment that rolled out the current configuration. */
    deploymentUuid: string | undefined;
    /** Keys of the environment variables this resource manages. */
    envKeys: string[];
    /** Hash of the desired configuration, including env values. Not a secret. */
    configHash: string;
  },
  never,
  Providers
>;

/**
 * An application Coolify builds and runs on one of your servers, behind its
 * proxy with automatic HTTPS.
 *
 * The image comes from the same props as every other Alchemy container
 * resource: a prebuilt `image`, or a `dockerfile` Coolify builds. A public
 * `git` repository is the Coolify-specific third source, built with
 * Nixpacks, Railpack, a static server or the repository's own Dockerfile.
 *
 * Every deploy blocks until Coolify's deployment finishes and fails with
 * the tail of the build log if it doesn't. Alchemy redeploys when the
 * configuration or an env value changes, or when the container isn't
 * running.
 *
 * @see https://coolify.io/docs/applications
 *
 * ### Running a prebuilt image
 * **Example:** nginx in the project's production environment
 * ```typescript
 * const project = yield* Coolify.Project("app", {});
 *
 * const web = yield* Coolify.Application("web", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   image: "nginx:1.27-alpine",
 *   ports: [80],
 * });
 *
 * return { url: web.url };
 * ```
 *
 * **Example:** Pinned image on your own domain
 * ```typescript
 * const api = yield* Coolify.Application("api", {
 *   project: project.projectUuid,
 *   environment: staging.environmentUuid,
 *   server: "<server-uuid>",
 *   image: "ghcr.io/acme/api@sha256:4f5c…",
 *   ports: [3000],
 *   domains: ["https://api.example.com"],
 *   healthCheck: { path: "/health" },
 *   limits: { memory: "512m", cpus: "1" },
 * });
 * ```
 *
 * ### Building a Dockerfile
 * **Example:** Inline Dockerfile
 * ```typescript
 * import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
 *
 * const hello = yield* Coolify.Application("hello", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   dockerfile: Dockerfile.inline`
 *     FROM busybox:1.36
 *     CMD ["httpd", "-f", "-p", "8080"]
 *   `,
 *   ports: [8080],
 * });
 * ```
 *
 * ### Building from Git
 * **Example:** Nixpacks build of a public repository
 * ```typescript
 * const site = yield* Coolify.Application("site", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   git: {
 *     repository: "https://github.com/coollabsio/coolify-examples",
 *     branch: "v4.x",
 *     baseDirectory: "/nodejs",
 *   },
 *   ports: [3000],
 * });
 * ```
 *
 * ### Environment variables and databases
 * **Example:** Connect an application to a Coolify Postgres
 * ```typescript
 * const db = yield* Coolify.Database.Postgres("db", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 * });
 *
 * yield* Coolify.Application("api", {
 *   project: project.projectUuid,
 *   environmentName: "production",
 *   server: "<server-uuid>",
 *   image: "ghcr.io/acme/api:1.4.2",
 *   ports: [3000],
 *   env: {
 *     NODE_ENV: "production",
 *     DATABASE_URL: db.internalUrl,
 *   },
 * });
 * ```
 *
 * @resource
 * @product Application
 */
export const Application = Resource<Application>("Coolify.Application");

/** The props name no source, or more than one. */
export class ApplicationSourceInvalid extends Data.TaggedError("Coolify.ApplicationSourceInvalid")<{
  readonly message: string;
}> {}

/** Neither `environment` nor `environmentName` was set. */
export class ApplicationEnvironmentRequired extends Data.TaggedError(
  "Coolify.ApplicationEnvironmentRequired",
)<{ readonly message: string }> {}

/** Coolify returned an application without the fields Alchemy needs. */
export class ApplicationUnexpectedResponse extends Data.TaggedError(
  "Coolify.ApplicationUnexpectedResponse",
)<{ readonly message: string }> {}

type Source =
  | { kind: "image"; imageName: string; imageTag: string }
  | { kind: "dockerfile"; content: string }
  | { kind: "git"; git: GitSource };

const sourceKind = (props: ApplicationProps): Source["kind"] | undefined =>
  props.image !== undefined
    ? "image"
    : props.dockerfile !== undefined
      ? "dockerfile"
      : props.git !== undefined
        ? "git"
        : undefined;

/**
 * Split an image reference the way Coolify stores it: `name@sha256` + hex
 * digest, or `name` + tag (`latest` when absent).
 */
export const splitImage = (image: string): { imageName: string; imageTag: string } => {
  const at = image.indexOf("@sha256:");
  if (at >= 0) {
    return { imageName: `${image.slice(0, at)}@sha256`, imageTag: image.slice(at + 8) };
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return { imageName: image.slice(0, colon), imageTag: image.slice(colon + 1) };
  return { imageName: image, imageTag: "latest" };
};

/** Docker Hub's implicit prefixes, which Coolify may or may not keep. */
const bareImageName = (name: string | null | undefined) =>
  (name ?? "").replace(/^docker\.io\/(library\/)?/, "");

const splitList = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const unwrap = (value: string | Redacted.Redacted<string> | null | undefined) =>
  value == null ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

export const ApplicationProvider = () =>
  Provider.effect(
    Application,
    Effect.gen(function* () {
      const getApplication = yield* Coolify.getApplication;
      const listApplications = yield* Coolify.listApplications;
      const createDockerimage = yield* Coolify.createDockerimageApplication;
      const createDockerfile = yield* Coolify.createDockerfileApplication;
      const createPublic = yield* Coolify.createPublicApplication;
      const updateApplication = yield* Coolify.updateApplicationByUuid;
      const deleteApplication = yield* Coolify.deleteApplication;
      const listEnvs = yield* Coolify.listEnvsByApplicationUuid;
      const upsertEnvs = yield* Coolify.updateEnvsByApplicationUuid;
      const deleteEnv = yield* Coolify.deleteEnvByApplicationUuid;
      const listTags = yield* Coolify.listTagsByApplicationUuid;
      const addTags = yield* Coolify.createTagByApplicationUuid;
      const removeTag = yield* Coolify.deleteTagByApplicationUuid;

      const observe = (uuid: string) =>
        getApplication({ uuid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

      const resolveSource = Effect.fn(function* (props: ApplicationProps) {
        const kinds = [props.image, props.dockerfile, props.git].filter((v) => v !== undefined);
        if (kinds.length !== 1) {
          return yield* new ApplicationSourceInvalid({
            message: "Coolify.Application needs exactly one of `image`, `dockerfile` or `git`",
          });
        }
        if (props.image !== undefined) {
          return { kind: "image", ...splitImage(props.image) } satisfies Source;
        }
        if (props.dockerfile !== undefined) {
          const content =
            typeof props.dockerfile === "string"
              ? yield* (yield* FileSystem.FileSystem).readFileString(props.dockerfile)
              : props.dockerfile.content;
          return { kind: "dockerfile", content } satisfies Source;
        }
        return { kind: "git", git: props.git! } satisfies Source;
      });

      // Everything a deploy depends on. Secrets are hashed, never stored.
      const configHashOf = Effect.fn(function* (
        name: string,
        props: ApplicationProps,
        source: Source,
      ) {
        return yield* hashOf({
          name,
          description: props.description,
          source,
          ports: props.ports,
          domains: props.domains,
          env: props.env,
          healthCheck: props.healthCheck,
          limits: props.limits,
        });
      });

      const toAttrs = (
        app: Coolify.Application,
        fields: {
          projectUuid: string;
          serverUuid: string;
          source: Source["kind"];
          deploymentUuid: string | undefined;
          envKeys: string[];
          configHash: string;
        },
      ) =>
        Effect.gen(function* () {
          if (!app.uuid || app.name === undefined) {
            return yield* new ApplicationUnexpectedResponse({
              message: "Coolify returned an application without a uuid or name",
            });
          }
          const domains = splitList(app.fqdn);
          return {
            applicationUuid: app.uuid,
            name: app.name,
            domains,
            url: domains[0],
            status: app.status ?? "unknown",
            ...fields,
          } satisfies Application["Attributes"];
        });

      const sourceOf = (app: Coolify.Application): Source["kind"] =>
        app.build_pack === "dockerimage" ? "image" : app.dockerfile ? "dockerfile" : "git";

      /** Fields to PATCH so the observed application matches the props. */
      const desiredUpdate = (
        observed: Coolify.Application,
        name: string,
        props: ApplicationProps,
        source: Source,
      ) => {
        const update: Partial<Coolify.UpdateApplicationByUuidRequest> = {};
        if (observed.name !== name) update.name = name;
        if ((observed.description ?? undefined) !== props.description) {
          update.description = props.description ?? "";
        }
        const ports = props.ports?.join(",");
        if (ports !== undefined && observed.ports_exposes !== ports) update.ports_exposes = ports;
        if (props.domains !== undefined) {
          const domains = props.domains.join(",");
          if (splitList(observed.fqdn).join(",") !== domains) update.domains = domains;
        }
        if (source.kind === "image") {
          if (
            bareImageName(observed.docker_registry_image_name) !== bareImageName(source.imageName)
          ) {
            update.docker_registry_image_name = source.imageName;
          }
          if ((observed.docker_registry_image_tag ?? "latest") !== source.imageTag) {
            update.docker_registry_image_tag = source.imageTag;
          }
        }
        if (source.kind === "git") {
          const git = source.git;
          if (observed.git_repository !== git.repository) update.git_repository = git.repository;
          if (observed.git_branch !== (git.branch ?? "main"))
            update.git_branch = git.branch ?? "main";
          if (git.commit !== undefined && observed.git_commit_sha !== git.commit) {
            update.git_commit_sha = git.commit;
          }
          if (observed.build_pack !== (git.buildPack ?? "nixpacks")) {
            update.build_pack = git.buildPack ?? "nixpacks";
          }
          if (git.baseDirectory !== undefined && observed.base_directory !== git.baseDirectory) {
            update.base_directory = git.baseDirectory;
          }
          if (
            git.publishDirectory !== undefined &&
            observed.publish_directory !== git.publishDirectory
          ) {
            update.publish_directory = git.publishDirectory;
          }
          if (
            git.dockerfileLocation !== undefined &&
            observed.dockerfile_location !== git.dockerfileLocation
          ) {
            update.dockerfile_location = git.dockerfileLocation;
          }
          if (git.installCommand !== undefined && observed.install_command !== git.installCommand) {
            update.install_command = git.installCommand;
          }
          if (git.buildCommand !== undefined && observed.build_command !== git.buildCommand) {
            update.build_command = git.buildCommand;
          }
          if (git.startCommand !== undefined && observed.start_command !== git.startCommand) {
            update.start_command = git.startCommand;
          }
        }
        const hc = props.healthCheck;
        if (hc !== undefined) {
          const enabled = hc.enabled ?? true;
          if (observed.health_check_enabled !== enabled) update.health_check_enabled = enabled;
          if (hc.path !== undefined && observed.health_check_path !== hc.path) {
            update.health_check_path = hc.path;
          }
          if (hc.port !== undefined && observed.health_check_port !== String(hc.port)) {
            update.health_check_port = String(hc.port);
          }
        }
        if (props.limits?.memory !== undefined && observed.limits_memory !== props.limits.memory) {
          update.limits_memory = props.limits.memory;
        }
        if (props.limits?.cpus !== undefined && observed.limits_cpus !== props.limits.cpus) {
          update.limits_cpus = props.limits.cpus;
        }
        return update;
      };

      const base64 = (content: string) =>
        Effect.sync(() => Buffer.from(content, "utf8").toString("base64"));

      const createApplication = Effect.fn(function* (
        name: string,
        props: ApplicationProps,
        source: Source,
      ) {
        const common = {
          project_uuid: props.project,
          server_uuid: props.server,
          environment_uuid: props.environment,
          environment_name: props.environment === undefined ? props.environmentName : undefined,
          destination_uuid: props.destination,
          name,
          description: props.description,
          ports_exposes: props.ports?.join(","),
          domains: props.domains?.join(","),
          tags: props.tags,
          instant_deploy: false,
        };
        const created =
          source.kind === "image"
            ? yield* createDockerimage({
                ...common,
                docker_registry_image_name: source.imageName,
                docker_registry_image_tag: source.imageTag,
              })
            : source.kind === "dockerfile"
              ? yield* createDockerfile({
                  ...common,
                  dockerfile: yield* base64(source.content),
                })
              : yield* createPublic({
                  ...common,
                  git_repository: source.git.repository,
                  git_branch: source.git.branch ?? "main",
                  git_commit_sha: source.git.commit,
                  build_pack: source.git.buildPack ?? "nixpacks",
                  base_directory: source.git.baseDirectory,
                  publish_directory: source.git.publishDirectory,
                  dockerfile_location: source.git.dockerfileLocation,
                  install_command: source.git.installCommand,
                  build_command: source.git.buildCommand,
                  start_command: source.git.startCommand,
                });
        if (!created.uuid) {
          return yield* new ApplicationUnexpectedResponse({
            message: "Coolify did not return the new application's uuid",
          });
        }
        return created.uuid;
      });

      const syncEnv = Effect.fn(function* (
        uuid: string,
        desired: Record<string, string | Redacted.Redacted<string>>,
        managed: ReadonlyArray<string>,
        force: boolean,
      ) {
        const observed = (yield* listEnvs({ uuid })).filter((env) => !env.is_preview);
        const byKey = new Map(observed.map((env) => [env.key ?? "", env]));
        // A value Coolify withholds (token without read:sensitive) can't be
        // compared, so it is rewritten whenever the configuration changed.
        const upserts = Object.entries(desired)
          .map(([key, value]) => ({ key, value: unwrap(value) ?? "" }))
          .filter(({ key, value }) => {
            const current = byKey.get(key);
            if (current === undefined) return true;
            const observedValue = unwrap(current.value);
            return observedValue === undefined ? force : observedValue !== value;
          });
        if (upserts.length > 0) {
          yield* upsertEnvs({
            uuid,
            data: upserts.map(({ key, value }) => ({ key, value, is_preview: false })),
          });
        }
        for (const key of managed) {
          const env = byKey.get(key);
          if (!(key in desired) && env?.uuid) {
            yield* deleteEnv({ uuid, env_uuid: env.uuid }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
            );
          }
        }
        return upserts.length > 0;
      });

      return {
        stables: ["applicationUuid", "projectUuid", "serverUuid", "source"],
        nuke: { dependsOn: ["Coolify.Project", "Coolify.Environment"] },

        list: () =>
          Effect.gen(function* () {
            const apps = yield* listApplications({});
            return yield* Effect.forEach(
              apps.filter((app) => looksGenerated(app.name)),
              (app) =>
                toAttrs(app, {
                  projectUuid: "",
                  serverUuid: "",
                  source: sourceOf(app),
                  deploymentUuid: undefined,
                  envKeys: [],
                  configHash: "",
                }),
            );
          }),

        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (news.project !== output.projectUuid || news.server !== output.serverUuid) {
            return { action: "replace" } as const;
          }
          // The environment and destination aren't readable back from the
          // application, so the previous props are the only record of them.
          if (
            olds !== undefined &&
            (news.environment !== olds.environment ||
              news.environmentName !== olds.environmentName ||
              news.destination !== olds.destination)
          ) {
            return { action: "replace" } as const;
          }
          if (sourceKind(news) !== output.source) return { action: "replace" } as const;
          const name = yield* resolveName(id, news.name, output.name);
          const source = yield* resolveSource(news);
          if ((yield* configHashOf(name, news, source)) !== output.configHash) {
            return { action: "update" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.applicationUuid) {
            const app = yield* observe(output.applicationUuid);
            if (!app) return undefined;
            return yield* toAttrs(app, {
              projectUuid: output.projectUuid,
              serverUuid: output.serverUuid,
              source: output.source,
              deploymentUuid: output.deploymentUuid,
              envKeys: output.envKeys,
              configHash: output.configHash,
            });
          }
          if (!olds) return undefined;
          const name = yield* resolveName(id, olds.name);
          const app = (yield* listApplications({})).find((a) => a.name === name);
          if (!app) return undefined;
          const attrs = yield* toAttrs(app, {
            projectUuid: olds.project,
            serverUuid: olds.server,
            source: sourceOf(app),
            deploymentUuid: undefined,
            envKeys: [],
            configHash: "",
          });
          return (yield* isGeneratedName(id, app.name)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          if (news.environment === undefined && news.environmentName === undefined) {
            return yield* new ApplicationEnvironmentRequired({
              message: "Coolify.Application needs `environment` or `environmentName`",
            });
          }
          const name = yield* resolveName(id, news.name, output?.name);
          const source = yield* resolveSource(news);
          const configHash = yield* configHashOf(name, news, source);
          const configChanged = configHash !== output?.configHash;

          // Observe
          let app = output?.applicationUuid ? yield* observe(output.applicationUuid) : undefined;

          // Ensure — created without deploying, so env vars land first.
          const created = app === undefined;
          if (app === undefined) {
            const uuid = yield* createApplication(name, news, source);
            app = yield* getApplication({ uuid });
          }
          const uuid = app.uuid!;

          // Sync — configuration, against the observed application.
          const update = desiredUpdate(app, name, news, source);
          if (
            source.kind === "dockerfile" &&
            (app.dockerfile ?? "").trim() !== source.content.trim()
          ) {
            update.dockerfile = yield* base64(source.content);
          }
          if (Object.keys(update).length > 0) {
            yield* updateApplication({ uuid, ...update });
          }

          // Sync — env vars and tags.
          const envChanged = yield* syncEnv(
            uuid,
            news.env ?? {},
            output?.envKeys ?? [],
            configChanged,
          );
          if (news.tags !== undefined) {
            yield* syncTags({
              list: () => listTags({ uuid }),
              add: (names) => addTags({ uuid, tag_names: names }),
              remove: (tagUuid) => removeTag({ uuid, tag_uuid: tagUuid }),
              desired: news.tags,
            });
          }

          // Deploy — when new, changed, or not running.
          const running = (app.status ?? "").startsWith("running");
          const needsDeploy =
            created || configChanged || envChanged || Object.keys(update).length > 0 || !running;
          const deploymentUuid = needsDeploy
            ? yield* deployAndWait(uuid, false)
            : output?.deploymentUuid;

          return yield* toAttrs(yield* getApplication({ uuid }), {
            projectUuid: news.project,
            serverUuid: news.server,
            source: source.kind,
            deploymentUuid,
            envKeys: Object.keys(news.env ?? {}),
            configHash,
          });
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteApplication({
            uuid: output.applicationUuid,
            delete_configurations: true,
            delete_volumes: true,
            docker_cleanup: true,
            delete_connected_networks: true,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
