import * as r2 from "@distilled.cloud/cloudflare/r2";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "TanStack Start",
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <Document>
      <Outlet />
    </Document>
  );
}

function Document(props: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        style={{
          margin: 0,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
