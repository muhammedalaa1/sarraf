import "./globals.css";
import { getPay } from "../lib/pay";

export const metadata = { title: "Sarraf shop" };
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { demo } = getPay();
  return (
    <html lang="en">
      <body>
        {demo && (
          <div className="banner">
            Demo mode: fake providers, no real money. Add sandbox keys to use real ones.
          </div>
        )}
        <header>
          <div className="wrap">
            <a className="brand" href="/">
              Sarraf shop
            </a>
            <nav>
              <a href="/">Shop</a>
              <a href="/orders">Orders</a>
            </nav>
          </div>
        </header>
        <main>
          <div className="wrap">{children}</div>
        </main>
      </body>
    </html>
  );
}
