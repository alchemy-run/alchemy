import rootPkg from "../../package.json";
import alchemyPkg from "../../packages/alchemy/package.json";

export const alchemyVersion = alchemyPkg.version;
export const effectVersion = rootPkg.workspaces.catalog.effect;
