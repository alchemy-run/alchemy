// An ordinary nitro API route with no backend involvement — nitro serves
// it in the same Worker, alongside the routes that dispatch the backend.
export default defineEventHandler(() => {
  return { hello: "from nitro" };
});
