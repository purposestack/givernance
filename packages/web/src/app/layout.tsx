import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  style: ["normal", "italic"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Givernance",
  description: "Purpose-built CRM for European nonprofits",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // cookies() opts the entire app out of static rendering — intentional for an
  // auth-gated SPA where every page needs session context (see ADR-011).
  // Do not remove without discussion: it provides CSRF and auth cookie access.
  const cookieStore = await cookies();
  const csrfToken = cookieStore.get("csrf-token")?.value;

  return (
    <html
      lang="en"
      className={`${inter.variable} ${newsreader.variable} ${jetbrainsMono.variable}`}
    >
      <head>{csrfToken && <meta name="csrf-token" content={csrfToken} />}</head>
      <body>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
        >
          Skip to content
        </a>
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
