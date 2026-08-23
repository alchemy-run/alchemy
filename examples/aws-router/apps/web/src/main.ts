const app = document.querySelector<HTMLElement>("#app")!;

app.innerHTML = `
  <h1>Web</h1>
  <p>Served through the shared <code>AWS.Website.Router</code>.</p>
  <p>This page is mounted at <code>/</code>.</p>
  <p>Edit <code>apps/web/src/main.ts</code> and this updates instantly under <code>alchemy dev</code>.</p>
  <p><a href="/docs/">Go to the docs site &rarr;</a></p>
  <pre>location.pathname = ${location.pathname}</pre>
`;
app.style.cssText =
  "font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6;";
document.body.style.cssText = "margin: 0; background: #f6f7fb;";
