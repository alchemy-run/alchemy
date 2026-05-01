import type { ReactNode } from "react";

export const metadata = {
  title: "alchemy + Next.js + OpenNext on Cloudflare",
  description:
    "Minimal example demonstrating Cloudflare.Worker({ bundle: false }) " +
    "with an OpenNext-built Next.js worker.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          margin: 0,
          padding: "2rem",
          background: "#0a0a0a",
          color: "#fafafa",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
