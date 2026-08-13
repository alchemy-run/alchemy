// An ordinary nitro API route — the alchemy middleware declines non-rpc
// paths, so nitro itself serves this in the same Lambda.
export default defineEventHandler(() => {
  return { hello: "from nitro" };
});
