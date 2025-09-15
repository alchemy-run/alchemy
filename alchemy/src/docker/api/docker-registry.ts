import type { Secret } from "../../secret.ts";

interface DockerRegistryUserAuth {
  username: string;
  password: Secret;
}

interface DockerRegistryTokenAuth {
  token: Secret;
}

export type DockerRegistryProps = {
  server?: string;
} & (DockerRegistryUserAuth | DockerRegistryTokenAuth);

class _DockerRegistry {
  readonly server: string;
  readonly username: string | undefined;
  readonly password: Secret | undefined;
  readonly token: Secret | undefined;

  constructor(props: DockerRegistryProps) {
    this.server = props.server || "docker.io";
    if ("token" in props && props.token) {
      this.token = props.token;
    } else if ("username" in props && props.username) {
      this.username = props.username;
      this.password = props.password;
    }
  }

  toBase64() {
    return Buffer.from(
      JSON.stringify({
        serveraddress: this.server,
        token: this.token ? this.token : undefined,
        username: this.username ? this.username : undefined,
        password: this.username ? this.password?.unencrypted : undefined,
      }),
    ).toString("base64");
  }
}

export async function DockerRegistry(props?: DockerRegistryProps) {
  return new _DockerRegistry({
    server: props?.server || "docker.io",
    token: (props as DockerRegistryTokenAuth)?.token,
    username: (props as DockerRegistryUserAuth)?.username,
    password: (props as DockerRegistryUserAuth)?.password,
  });
}
export type DockerRegistry = InstanceType<typeof _DockerRegistry>;
