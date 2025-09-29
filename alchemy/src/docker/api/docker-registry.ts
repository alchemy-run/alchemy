import { alchemy } from "../../alchemy.ts";
import type { Secret } from "../../secret.ts";
import { CredentialsStore } from "./credentials-store.ts";

export type DockerRegistryProps = {
  /**
   * Registry server URL.
   * @default "docker.io"
   */
  server?: string;

  /**
   * Token for authentication.
   *
   * Takes precedence over `username` and `password`
   */
  token?: Secret;

  /**
   * Username for authentication
   *
   * Used in conjunction with `password`
   */
  username?: string;

  /**
   * Password for authentication
   *
   * Used in conjunction with `username`
   */
  password?: Secret;

  /**
   * Path to the credentials store to use. Takes precedence over the DockerHost's credentialsStore.
   *
   * Only used if no other authentication detail is provided.
   */
  credentialsStore?:
    | string
    | {
        /**
         * Path to the credentials store to use.
         */
        path?: string;

        /**
         * Whether to save the credentials to the credentials store.
         * @default true
         */
        save?: boolean | "registry-store" | "host-store" | "both";

        /**
         * Whether to fallback to the DockerHost's credentialsStore if credentials could not be found in this credentials store.
         * @default false
         */
        fallback?: boolean;
      };
};

export class _DockerRegistry {
  server: string;
  username: string | undefined;
  password: Secret | undefined;
  token: Secret | undefined;
  customCredentialsStoreSpecified?: boolean;
  credentialsStore?: CredentialsStore | undefined;
  saveToStore?: boolean | "registry-store" | "host-store" | "both";
  fallbackToHost?: boolean;

  constructor(props: DockerRegistryProps) {
    this.server = props.server || "docker.io";
    if ("token" in props && props.token) {
      this.token = props.token;
    } else if ("username" in props && props.username) {
      this.username = props.username;
      this.password = props.password;
    }

    this.customCredentialsStoreSpecified =
      typeof props.credentialsStore === "string" ||
      !!props.credentialsStore?.path;

    if (typeof props.credentialsStore !== "string") {
      this.saveToStore = props.credentialsStore?.save;
      this.fallbackToHost = props.credentialsStore?.fallback;
    }

    this.credentialsStore =
      typeof props?.credentialsStore === "string"
        ? new CredentialsStore(props.credentialsStore)
        : props?.credentialsStore?.path
          ? new CredentialsStore(props.credentialsStore.path)
          : undefined;
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
  let server: string = props?.server || "docker.io";
  let token: Secret | undefined = props?.token;
  let username: string | undefined = props?.username;
  let password: Secret | undefined = props?.password;

  let credentialsStore: CredentialsStore | undefined =
    typeof props?.credentialsStore === "string"
      ? new CredentialsStore(props.credentialsStore)
      : props?.credentialsStore?.path
        ? new CredentialsStore(props.credentialsStore.path)
        : undefined;

  if (credentialsStore) {
    if (!props?.token && !props?.username && !props?.password) {
      const credential = await credentialsStore.get(server);
      if (credential) {
        username = credential.Username;
        password = alchemy.secret(credential.Secret);
      } else if (
        typeof props?.credentialsStore === "object" &&
        // If it were true, we want to fallback. If undefined we dont do the
        // check either but leave it up to the DockerHost to decide.
        props?.credentialsStore?.fallback === false
      ) {
        throw new Error(
          `No credential were provided or found for registry ${server} in the credential store`,
        );
      }
    } else if (
      props?.username &&
      props?.password &&
      typeof props?.credentialsStore === "object" &&
      (props?.credentialsStore?.save === "registry-store" ||
        props?.credentialsStore?.save === "both")
    ) {
      await credentialsStore.store({
        ServerURL: server,
        Username: props.username,
        Secret: props.password.unencrypted,
      });
    }
  }

  return new _DockerRegistry({
    server,
    token,
    username,
    password,
    credentialsStore: props?.credentialsStore,
  });
}
export type DockerRegistry = InstanceType<typeof _DockerRegistry>;
