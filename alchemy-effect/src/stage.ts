const args = typeof process !== "undefined" ? process.argv.slice(2) : [];

const parseOption = (argName: string) => {
  const i = args.indexOf(argName);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

export const $stage =
  import.meta.env.STAGE ?? parseOption("--stage") ?? `dev-${import.meta.env.USER ?? "unknown"}`;

export interface StageConfig {}
