// An ordinary nitro API route — excluded from the effect claim, so it is
// served by nitro itself in the same Lambda.
export default defineEventHandler(() => {
  return { hello: "from nitro" };
});
