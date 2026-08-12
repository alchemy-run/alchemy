// Minimal client module referenced by index.html — the SPA half of the
// effectful Website fixture. The interesting half is `../site.ts`.
const el = document.getElementById("app");
if (el) {
  el.textContent = `${el.textContent} (hydrated)`;
}
