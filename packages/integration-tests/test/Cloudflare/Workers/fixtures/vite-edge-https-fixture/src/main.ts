// Served by the Vite dev server itself (transformed module), so a request
// for it proves assets reach Vite through the local edge.
export const marker = "vite-edge-fixture-main";
document.getElementById("app")!.textContent = marker;
