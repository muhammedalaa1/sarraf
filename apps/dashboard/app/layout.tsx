import "./globals.css";
import { getSarraf } from "../lib/sarraf";

export const metadata = {
  title: "Sarraf Sandbox",
  description: "Sandbox playground and webhook inbox for Sarraf.",
};
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { demo, error, pay } = getSarraf();
  return (
    <html lang="en">
      <body>
        <output className="banner">
          Sandbox — no real money.{" "}
          {demo ? "Demo mode: fake providers." : `Providers: ${pay.providerIds.join(", ")}.`}
        </output>
        {error && (
          <div className="banner" role="alert">
            Configuration refused: {error}
          </div>
        )}
        <header>
          <nav>
            <strong>Sarraf Sandbox</strong>
            <a href="/">Playground</a>
            <a href="/operations">Operations</a>
            <a href="/inbox">Webhook inbox</a>
            <a href="/status">Status explorer</a>
            <a href="/capabilities">Capabilities</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
