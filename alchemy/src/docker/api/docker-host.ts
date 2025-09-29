import Dockerode from "dockerode";
import os from "node:os";
import { alchemy } from "../../alchemy.ts";
import { CredentialsStore } from "./credentials-store.ts";
import type { _DockerRegistry, DockerRegistry } from "./docker-registry.ts";

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

    // const configDir =
    //   props.dir === true
    //     ? path.resolve(
    //         process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker"),
    //       )
    //     : props.dir || undefined;

    // if (configDir && existsSync(path.resolve(configDir, "config.json"))) {
    //   // parse config.json
    //   const config = JSON.parse(
    //     readFileSync(path.resolve(configDir, "config.json"), "utf8"),
    //   );

    //   if (config.credsStore) {
    //     credentialsStore = new CredentialsStore(
    //       `docker-credential-${config.credsStore}`,
    //     );
    //   }

    //   if (config.auths) {
    //     for (const [registry, entry] of Object.entries<{
    //       auth?: string;
    //       identitytoken?: string;
    //     }>(config.auths)) {
    //       if (entry.auth) {
    //         const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
    //         const idx = decoded.indexOf(":");
    //         const username = decoded.slice(0, idx);
    //         const password = decoded.slice(idx + 1);
    //         // @ts-expect-error - initializing generic type
    //         this.registries[registry] = new _DockerRegistry({
    //           server: registry,
    //           username,
    //           password: alchemy.secret(password),
    //         });
    //       }

    //       if (entry.identitytoken) {
    //         // @ts-expect-error - initializing generic type
    //         this.registries[registry] = new _DockerRegistry({
    //           server: registry,
    //           token: alchemy.secret(entry.identitytoken),
    //         });
    //       }
    //     }
    //   }
    // }

    // We want to save the DOCKER_HOST environment variable as we are overriding it
    const previousDockerHostEnvironment = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;
    console.log("dockerodeOptions", dockerodeOptions);
    // console.log("credentialsStore", credentialsStore);
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
>(props: DockerHostProps<Registries> = {}): Promise<DockerHost<Registries>> {
  if (props instanceof _DockerHost) {
    return props;
  }

  let fallbackByDefault = false;
  let credentialsStore: CredentialsStore | undefined;

  if (typeof props?.credentialsStore === "string") {
    credentialsStore = new CredentialsStore(props.credentialsStore);
  } else if (props?.credentialsStore?.path) {
    credentialsStore = new CredentialsStore(props.credentialsStore.path);
    fallbackByDefault = props.credentialsStore.fallbackByDefault ?? false;
  }

  if (props.registries) {
    for (const registry of Object.values<_DockerRegistry>(props.registries)) {
      if (!registry.token && !registry.username && !registry.password) {
        if (
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
        //------------------------------------
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
