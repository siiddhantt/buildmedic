import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BuildMedic — GitAgent CI Triage",
  description:
    "GitAgent-powered CI failure triage assistant for GitHub pull requests. Read-only diagnosis, evidence-backed root cause analysis, and approval-ready patch plans.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-[Inter,ui-sans-serif,system-ui,sans-serif] antialiased">
        {children}
      </body>
    </html>
  );
}
