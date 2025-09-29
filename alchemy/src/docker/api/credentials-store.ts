import { execFile } from "node:child_process";
import which from "which";

interface Credential {
  ServerURL: string;
  Username: string;
  Secret: string;
}

export interface ListResult {
  [serverURL: string]: string;
}

export class CredentialsStore {
  constructor(
    /**
     * Path to the credentials store. Explicitly specify ./ or ../ for relative
     * paths. Otherwise, it will be searched through the PATH environment variable.
     *
     * Example:
     * - `docker-credential-desktop` will be searched through the PATH environment variable.
     * - `./docker-credential-desktop` will be searched in the current directory.
     * - `/var/run/docker/desktop/docker-credential-desktop` will be directly used.
     */
    public readonly path: string,
  ) {
    const whichPath = which.sync(path, { nothrow: true });
    if (!whichPath) {
      if (path.includes("/")) {
        throw new Error(`Credential store binary ${path} not found`);
      }

      throw new Error(`Credential store binary ${path} not found in PATH`);
    }

    this.path = whichPath;
  }

  #run<T>(command: string, args?: string) {
    return new Promise<T | string | null>((resolve, reject) => {
      const child = execFile(
        this.path,
        [command],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            const msg = stderr || stdout || error.message;
            if (msg.includes("not found")) {
              return resolve(null);
            }
            const verb = {
              store: "storing",
              get: "getting",
              erase: "erasing",
              list: "listing",
              version: "getting",
            }[command];
            return reject(new Error(`Error ${verb} credential: ${msg}`));
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(stdout as string);
          }
        },
      );

      if (args) child.stdin?.end(args);
      else child.stdin?.end();
    });
  }

  async store(credential: Credential) {
    await this.#run("store", JSON.stringify(credential));
  }

  async get(serverURL: string) {
    return (await this.#run("get", serverURL)) as Credential | null;
  }

  async erase(serverURL: string) {
    await this.#run("erase", serverURL);
  }

  async list() {
    return await this.#run<ListResult>("list");
  }

  async version() {
    return await this.#run<string>("version");
  }
}
