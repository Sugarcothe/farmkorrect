import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

// The preview card shown when a link to the app is shared (WhatsApp, Facebook,
// X, LinkedIn, Slack…). Rendered once at build time; every route inherits it.

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const features = ["Find Vets", "Explore Market", "Start Training", "Track Finances"];

export default async function OpenGraphImage() {
  const logo = await readFile(join(process.cwd(), "public/icons/icon-512.png"));
  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 80px",
          gap: 64,
          color: "white",
          backgroundImage: "linear-gradient(160deg, #087a3d 0%, #004b2e 55%, #003b25 100%)",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 280,
            height: 280,
            flexShrink: 0,
            borderRadius: 64,
            overflow: "hidden",
            backgroundColor: "white",
            boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse only renders plain img */}
          <img src={logoSrc} width={280} height={280} alt="" style={{ borderRadius: 64 }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }}>
            {SITE.name}
          </div>
          <div style={{ marginTop: 16, fontSize: 38, color: "rgba(255,255,255,0.8)" }}>
            {SITE.tagline}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 40, maxWidth: 680 }}>
            {features.map((feature) => (
              <div
                key={feature}
                style={{
                  display: "flex",
                  padding: "10px 22px",
                  borderRadius: 999,
                  fontSize: 26,
                  backgroundColor: "rgba(255,255,255,0.14)",
                  border: "1px solid rgba(255,255,255,0.25)",
                }}
              >
                {feature}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
