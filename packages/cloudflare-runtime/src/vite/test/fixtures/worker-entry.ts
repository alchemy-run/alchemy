export class ApplicationDurableObject {}

export default {
  fetch(): Response {
    return new Response("application");
  },
};
