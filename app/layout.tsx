import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { InstallBanner } from "@/components/pwa/install-banner";
import { ServiceWorkerRegistration } from "./service-worker-registration";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Farm Korret Nig",
  applicationName: "Farm Korret Nig",
  description:
    "Farm Korret Nig — the poultry farming and agricultural marketplace for Nigerian farmers.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Farm Korret",
  },
  // favicon.ico, icon.png and apple-icon.png in app/ supply the icon tags
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#004b2e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        className="min-h-full flex flex-col overscroll-none"
        suppressHydrationWarning
      >
        {children}
        <InstallBanner />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
