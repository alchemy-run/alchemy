import { readlinkSync, statSync } from "node:fs";

export const resolveRuntimePaths = () => {
  return {
    config: ".alchemy/local/wrangler.jsonc",
    persist: resolveMiniflarePersistPath(".alchemy/miniflare"),
  };
};

export const resolveMiniflarePersistPath = (path = ".alchemy/miniflare") => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) {
    const [command] = process.argv.slice(-1);
    if (
      ["build", "prepare", "typegen"].includes(command) ||
      process.env.NODE_ENV === "production"
    ) {
      console.warn(`Miniflare persist path ${path} does not exist.`);
      return path;
    }
    throw new Error(`Miniflare persist path ${path} does not exist`);
  }
  if (stat.isSymbolicLink()) {
    return readlinkSync(path);
  }
  return path;
};
