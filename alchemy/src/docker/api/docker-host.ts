import Dockerode from "dockerode";
import os from "node:os";
import type { DockerRegistry } from "./docker-registry.ts";

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
}

class _DockerHost<Registries extends Record<string, DockerRegistry>> {
  #dockerode: Dockerode;
  readonly url: string;
  readonly registries: Registries;

  constructor(props: DockerHostProps<Registries>) {
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

    // We want to override the DOCKER_HOST environment variable as we are overriding it
    const previousDockerHostEnvironment = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;
    this.#dockerode = new Dockerode(dockerodeOptions);
    this.url = url.toString();
    process.env.DOCKER_HOST = previousDockerHostEnvironment;

    this.registries = props.registries || ({} as Registries);
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

  return new _DockerHost(props);
}
export type DockerHost<
  Registries extends Record<string, DockerRegistry> = Record<
    string,
    DockerRegistry
  >,
> = InstanceType<typeof _DockerHost<Registries>>;
