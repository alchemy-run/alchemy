const recordPatch = (name) => {
  process.env.ALCHEMY_VARLOCK_PATCH_PROBE_CALLS = [
    process.env.ALCHEMY_VARLOCK_PATCH_PROBE_CALLS,
    name,
  ]
    .filter(Boolean)
    .join(",");
};

export const load = async () => {
  process.env.ALCHEMY_VARLOCK_PATCH_PROBE_LOADED = "true";
};

export const patchGlobalConsole = () => recordPatch("console");
export const patchGlobalResponse = () => recordPatch("response");
export const patchGlobalServerResponse = () => recordPatch("server-response");
