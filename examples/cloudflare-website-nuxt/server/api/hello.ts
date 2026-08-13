// An ordinary nitro API route — excluded from the effect claim
// (`!/api/hello`), so nitro serves it in the same Worker.
export default defineEventHandler(() => {
  return { hello: "from nitro" };
});
