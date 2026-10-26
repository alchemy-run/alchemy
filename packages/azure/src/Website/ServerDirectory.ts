import type * as Bundle from "alchemy/Bundle/Bundle";

type BundlePlugins = NonNullable<NonNullable<Bundle.BundleConfig["input"]>["plugins"]>;

/** Root files of the server directory the Function package already has. */
const SKIPPED_ROOT_FILES = new Set(["host.json", "package.json"]);

const dirnameOf = (file: string) =>
  file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));

/**
 * Rolldown options that ship the server entry's whole directory in the
 * Function package, at the package root next to the bundled `index.mjs`.
 *
 * A framework whose server cannot be bundled (Next.js loads its compiled
 * pages and its `next` package from disk at run time) writes a
 * self-contained directory with its own `node_modules` and an entry that
 * `require`s them through `createRequire(import.meta.url)`. The bundled
 * entry then resolves them from the package root, where this plugin puts
 * every file of that directory.
 */
export const serverDirectoryBuild = (entry: string): Bundle.BundleConfig => {
  const root = dirnameOf(entry);
  const plugins: BundlePlugins = [
    {
      name: "alchemy:azure-website-server-directory",
      // Rolldown plugin hooks are Promise-based; `this.fs` is rolldown's file system API.
      async buildStart() {
        const walk = async (dir: string, prefix: string): Promise<void> => {
          const entries = await this.fs.readdir(dir, { withFileTypes: true });
          for (const item of entries) {
            const file = `${dir}/${item.name}`;
            const name = `${prefix}${item.name}`;
            // Follow links: package managers link packages into node_modules.
            const stat = item.isSymbolicLink() ? await this.fs.stat(file) : item;
            if (stat.isDirectory()) {
              await walk(file, `${name}/`);
            } else if (
              stat.isFile() &&
              file !== entry &&
              !(prefix === "" && SKIPPED_ROOT_FILES.has(item.name))
            ) {
              this.emitFile({
                type: "asset",
                fileName: name,
                source: await this.fs.readFile(file),
              });
            }
          }
        };
        await walk(root, "");
      },
    },
  ];
  return { input: { plugins } };
};
