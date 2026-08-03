import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "EscrowFi — SME Trade Finance on Arc",
  description: "Compliance-as-collateral working capital: escrow, SA-gated advances, verifiable credit passports.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">EscrowFi</a>
          <nav>
            <a href="/">Console</a>
            <a href="/passport/854638">Credit Passport</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
