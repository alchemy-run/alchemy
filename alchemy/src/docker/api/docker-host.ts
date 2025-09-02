import Dockerode from "dockerode";
import os from "node:os";

export interface DockerHostProps {
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
  registries?: (RegistryUserAuth | IdentityTokenAuth)[];
}

interface RegistryUserAuth {
  // username: string;
  // password: string;
  // email: string;
  serverAddress: string;
}

interface IdentityTokenAuth {
  // identitytoken: string;
  serverAddress: string;
}

class DockerHostClass {
  #dockerode: Dockerode;
  readonly url: string;

  constructor(props: DockerHostProps) {
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
      dockerodeOptions.protocol = props.ca ? "https" : "http";
      dockerodeOptions.ca = props.ca;
      dockerodeOptions.cert = props.cert;
      dockerodeOptions.key = props.key;
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
  }

  get dockerode() {
    return this.#dockerode;
  }
}
Object.defineProperty(DockerHostClass, "name", { value: "DockerHost" });

export async function DockerHost(props: DockerHostProps = {}) {
  if (props instanceof DockerHostClass) {
    return props;
  }

  return new DockerHostClass(props);
}
export type DockerHost = InstanceType<typeof DockerHostClass>;
