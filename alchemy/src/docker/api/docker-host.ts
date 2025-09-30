import Dockerode from "dockerode";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alchemy } from "../../alchemy.ts";
import { CredentialsStore } from "./credentials-store.ts";
import { DockerRegistry, type _DockerRegistry } from "./docker-registry.ts";

export interface DockerHostProps<
  Registries extends Record<string, DockerRegistry> = Record<
    string,
    DockerRegistry
  >,
> {
  /**
   * The URL of the Docker daemon.
   * @example
   * - `unix:///var/run/docker.sock`
   * - `tcp://127.0.0.1:2375`
   */
  url?: string;

  /**
   * The directory to use for the Docker configuration.
   *
   * If set to `true`, it will be resolved to:
   * ```
   * process.env.DOCKER_CONFIG || (os.homedir() + ".docker")
   * ```
   */
  dir?: true | string;

  /**
   * The CA certificate to use to connect to the Docker daemon.
   */
  ca?: string;

  /**
   * The certificate to use to connect to the Docker daemon.
   */
  cert?: string;

  /**
   * The key to use to connect to the Docker daemon.
   */
  key?: string;

  /**
   * Registries to authenticate to
   */
  registries?: Registries;

  /**
   * Path to the credentials store to use.
   * By default, credential store is read-only. Set `credentialsStore.save` to
   * `true` to save the credentials in the script to the store.
   *
   * @example
   * - `docker-credential-desktop`
   * - `docker-credential-secretservice`
   * - `docker-credential-pass`
   * - `docker-credential-osxkeychain`
   * - `docker-credential-wincred`
   * - `docker-credential-ecr-login`
   * - `docker-credential-gcloud`
   * - `docker-credential-azure`
   */
  credentialsStore?:
    | {
        /**
         * Path to the credentials store to use.
         */
        path?: string;

        /**
         * Whether to save the credentials to the credentials store. Cascades to
         *  registries by default. You can override this on a per-registry basis.
         * @default false
         */
        save?: boolean;

        /**
         * Whether to fallback to the DockerHost's credentialsStore if credentials could not be found in a registry's credentials store.
         * @default false
         */
        fallbackByDefault?: boolean;
      }
    | string;
}

class _DockerHost<Registries extends Record<string, DockerRegistry>> {
  #dockerode: Dockerode;
  readonly url: string;
  readonly registries: Registries;

  constructor(props: DockerHostProps<Registries>) {
    this.registries = {} as Registries;
    const dockerodeOptions: Dockerode.DockerOptions = {};
    const url = new URL(
      props.url ||
        process.env.DOCKER_HOST ||
        (os.type() === "Windows_NT"
          ? "npipe:////./pipe/docker_engine"
          : "unix:///var/run/docker.sock"),
    );

    if (url.protocol === "unix:" || url.protocol === "npipe:") {
      dockerodeOptions.socketPath = url.pathname;
    } else if (url.protocol === "tcp:") {
      dockerodeOptions.host = url.hostname;
      dockerodeOptions.port = url.port;
      const isHttps = props.ca && props.cert && props.key;
      dockerodeOptions.protocol = "http";
      if (isHttps) {
        dockerodeOptions.protocol = "https";
        dockerodeOptions.ca = props.ca;
        dockerodeOptions.cert = props.cert;
        dockerodeOptions.key = props.key;
      }
    } else {
      // TODO: Add support and tests for ssh:// protocol
      throw new Error(`Invalid Docker protocol: ${url.protocol}`);
    }

    // We want to save the DOCKER_HOST environment variable as we are overriding it
    const previousDockerHostEnvironment = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;
    this.#dockerode = new Dockerode(dockerodeOptions);
    this.url = url.toString();
    process.env.DOCKER_HOST = previousDockerHostEnvironment;

    Object.assign(this.registries, props.registries);
  }

  get dockerode() {
    return this.#dockerode;
  }
}
Object.defineProperty(_DockerHost, "name", { value: "DockerHost" });

export async function DockerHost<
  Registries extends Record<string, DockerRegistry>,
>(
  props: DockerHostProps<Registries> = {
    dir: path.resolve(process.env.DOCKER_CONFIG || os.homedir(), ".docker"),
  },
): Promise<DockerHost<Registries>> {
  if (props instanceof _DockerHost) {
    return props;
  }

  const configDir =
    props.dir === true
      ? process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker")
      : props.dir || undefined;

  let dockerConfig: DockerCliConfig | undefined;

  if (configDir && (await fs.exists(path.resolve(configDir, "config.json")))) {
    dockerConfig = JSON.parse(
      await fs.readFile(path.resolve(configDir, "config.json"), "utf8"),
    ) as DockerCliConfig;

    if (dockerConfig.credsStore && !props.credentialsStore) {
      props.credentialsStore = `docker-credential-${dockerConfig.credsStore}`;
    }
  }

  // Registry credentials
  let fallbackByDefault = false;
  let credentialsStore: CredentialsStore | undefined;
  if (typeof props?.credentialsStore === "string") {
    credentialsStore = new CredentialsStore(props.credentialsStore);
  } else if (props?.credentialsStore?.path) {
    credentialsStore = new CredentialsStore(props.credentialsStore.path);
    fallbackByDefault = props.credentialsStore.fallbackByDefault ?? false;
  }

  const addressToRegistryMap: Record<string, DockerRegistry> = {};
  props.registries ??= {} as Registries;
  for (const registry of Object.values<_DockerRegistry>(props.registries)) {
    if (!registry.token && !registry.username && !registry.password) {
      const savedCredentials = dockerConfig?.auths?.[registry.server];
      if (savedCredentials?.auth) {
        const decoded = Buffer.from(savedCredentials.auth, "base64").toString(
          "utf8",
        );
        const idx = decoded.indexOf(":");
        registry.username = decoded.slice(0, idx);
        registry.password = alchemy.secret(decoded.slice(idx + 1));
      }

      if (dockerConfig?.credHelpers?.[registry.server]) {
        // an empty object means credentials are saved in the store
        registry.customCredentialsStoreSpecified = true;
        const registryCredentialStore = new CredentialsStore(
          `docker-credential-${dockerConfig.credHelpers[registry.server]}`,
        );
        const credential = await registryCredentialStore.get(registry.server);
        if (credential) {
          registry.username = credential.Username;
          registry.password = alchemy.secret(credential.Secret);
        }
      }

      if (
        !registry.username &&
        !registry.password &&
        !registry.token &&
        registry.customCredentialsStoreSpecified &&
        !(registry.fallbackToHost ?? fallbackByDefault)
      ) {
        throw new Error(
          `No credentials were provided or found for registry ${registry.server} in registry nor host credentials stores`,
        );
      }

      if (credentialsStore) {
        const credential = await credentialsStore.get(registry.server);
        if (credential) {
          registry.username = credential.Username;
          registry.password = alchemy.secret(credential.Secret);

          if (
            registry.credentialsStore &&
            (registry.saveToStore === true ||
              registry.saveToStore === "registry-store" ||
              registry.saveToStore === "both")
          ) {
            await registry.credentialsStore.store({
              ServerURL: registry.server,
              Username: registry.username,
              Secret: registry.password.unencrypted,
            });
          }

          if (
            registry.saveToStore === "host-store" ||
            registry.saveToStore === "both"
          ) {
            await credentialsStore.store({
              ServerURL: registry.server,
              Username: registry.username,
              Secret: registry.password.unencrypted,
            });
          }
        } else {
          throw new Error(
            `No credentials were provided or found for registry ${registry.server} in registry nor host credentials stores`,
          );
        }
      }
    } else if (registry.username && registry.password) {
      // Already had credentials either from props or from the registry's credentials store
      // Registry already handled saving to the registry-store so we only
      // need to save to the host store here
      if (
        credentialsStore &&
        (registry.saveToStore === "host-store" ||
          registry.saveToStore === "both")
      ) {
        await credentialsStore.store({
          ServerURL: registry.server,
          Username: registry.username,
          Secret: registry.password.unencrypted,
        });
      }
    }

    addressToRegistryMap[registry.server] = registry;
  }

  if (dockerConfig?.auths) {
    for (const [registryAddress, entry] of Object.entries<{
      auth?: string;
    }>(dockerConfig.auths)) {
      let registry = addressToRegistryMap[registryAddress];
      if (registry?.username && registry?.password) {
        continue;
      }

      if (entry.auth) {
        const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (registry) {
          registry.username = decoded.slice(0, idx);
          registry.password = alchemy.secret(decoded.slice(idx + 1));
        } else {
          registry = await DockerRegistry({
            server: registryAddress,
            username: decoded.slice(0, idx),
            password: alchemy.secret(decoded.slice(idx + 1)),
          });
          props.registries[registryAddress as keyof Registries] =
            registry as Registries[keyof Registries];
        }
      } else if (Object.keys(entry).length === 0) {
        // Empty object means get from credential store
        const credHelper = dockerConfig?.credHelpers?.[registryAddress];
        const store = credHelper
          ? new CredentialsStore(`docker-credential-${credHelper}`)
          : credentialsStore;

        if (store) {
          const creds = await store.get(registryAddress);
          if (creds) {
            if (registry) {
              registry.username = creds.Username;
              registry.password = alchemy.secret(creds.Secret);
            } else {
              registry = await DockerRegistry({
                server: registryAddress,
                username: creds.Username,
                password: alchemy.secret(creds.Secret),
              });
              props.registries[registryAddress as keyof Registries] =
                registry as Registries[keyof Registries];
            }
          }
        }
      }
    }
  }

  return new _DockerHost(props);
}
export type DockerHost<
  Registries extends Record<string, DockerRegistry> = Record<
    string,
    DockerRegistry
  >,
> = InstanceType<typeof _DockerHost<Registries>>;

interface DockerCliConfig {
  auths?: Record<string, { auth?: string; identitytoken?: string }>;
  credHelpers?: Record<string, string>;
  credsStore?: string;
}
