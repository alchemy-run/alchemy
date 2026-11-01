// On STACKIT the server runs in a Function's Node process, so environment values
// declared in alchemy.run.ts are read from `process.env`.
export const load = () => {
  return {
    greeting: process.env.GREETING ?? "Hello!",
  };
};
