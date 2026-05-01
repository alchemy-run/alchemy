// Minimal client entry. The cloudflare-vite-plugin handles the worker
// runtime separately; this file just satisfies the `index.html` script tag
// reference so Vite emits a real client bundle.
const el = document.getElementById("app");
if (el) {
  el.textContent = `${el.textContent} (hydrated)`;
}
