// The server runs on an Azure Functions app (Node.js), so environment values
// declared in alchemy.run.ts are app settings, read from `process.env`.
export const load = () => {
  return {
    greeting: process.env.GREETING ?? "Hello!",
  };
};
