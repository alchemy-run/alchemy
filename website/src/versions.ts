import workspaceYaml from "../../pnpm-workspace.yaml?raw";
import alchemyPkg from "../../packages/alchemy/package.json" with { type: "json" };
import { parse } from "yaml";

const workspace = parse(workspaceYaml) as {
  catalogs: { effect: { effect: string } };
};

export const alchemyVersion = alchemyPkg.version;
export const effectVersion = workspace.catalogs.effect.effect;
