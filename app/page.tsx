import { LandingPage } from "@/components/landing/landing-page";
import { Splash } from "@/components/landing/splash";

// "/" is the splash on phones and tablets (it sends people on into the app)
// and the landing page on desktop. Both are rendered; CSS shows one of them,
// and the splash only redirects below the desktop breakpoint.
export default function Home() {
  return (
    <>
      <Splash />
      <LandingPage />
    </>
  );
}
