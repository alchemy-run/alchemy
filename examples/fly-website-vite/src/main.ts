import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element");
}

app.innerHTML = `
  <main class="page">
    <p class="eyebrow">alchemy + vite</p>
    <h1>Deploy a Vite SPA to Fly with Fly.Website.Vite.</h1>
    <p class="lede">
      This example runs a Vite build and serves the generated assets from a
      Fly Machine via <code>Fly.Website.Vite</code>.
    </p>
    <ul class="highlights">
      <li>Static <code>vite build</code> output baked into the Machine image</li>
      <li>Shared Anycast IPv4 so <code>{app}.fly.dev</code> answers</li>
      <li><code>alchemy dev</code> is Vite's own server — no cloud resources</li>
    </ul>
  </main>
`;
