import "./globals.css";

export const metadata = {
  title: "aws-website-nextjs",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
