// An ordinary nitro API route. On Azure the nitro server runs on a Flex
// Consumption Function, so environment values from alchemy.run.ts are read from
// `process.env`.
export default defineEventHandler(() => {
  return {
    greeting: typeof process.env.GREETING === "string" ? process.env.GREETING : null,
  };
});
