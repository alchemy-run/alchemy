export default {
  fetch() {
    return new Response("Fallback");
  },
} satisfies ExportedHandler;
