// An ordinary nitro API route. On STACKIT the nitro server runs in a
// Function's Node process, so environment values from alchemy.run.ts are read from
// `process.env`.
export default defineEventHandler(() => {
  return {
    greeting: typeof process.env.GREETING === "string" ? process.env.GREETING : null,
  };
});
