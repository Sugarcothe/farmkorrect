"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Dots } from "@/components/onboarding/dots";
import { setOnboarded } from "@/lib/storage";

const slides = [
  {
    image: "/slide-1.png",
    alt: "Smiling farmer in a straw hat and overalls standing in a barn",
    title: "Everything Poultry, One App",
    description:
      "Connect with veterinarians, suppliers, buyers, and farm services from a single platform.",
  },
  {
    image: "/slide-2.jpg",
    alt: "Bright poultry house with chickens, feeders and drinkers in neat rows",
    title: "Manage Your Farm Smarter",
    description:
      "Track production, expenses, feed consumption, profits, and daily farm activities with ease.",
  },
  {
    image: "/slide-3.png",
    alt: "Farmer smiling while checking a tablet among crops in a greenhouse",
    title: "Learn, Trade & Grow",
    description:
      "Access expert training, buy and sell products, and discover new opportunities to grow your poultry business.",
  },
];

const SWIPE_THRESHOLD = 50;

export default function Onboarding() {
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const isLast = index === slides.length - 1;

  function goTo(next: number) {
    setIndex(Math.max(0, Math.min(slides.length - 1, next)));
  }

  function handleNext() {
    if (isLast) return;
    goTo(index + 1);
  }

  function handleSkip() {
    goTo(slides.length - 1);
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (delta < -SWIPE_THRESHOLD) handleNext();
    if (delta > SWIPE_THRESHOLD) goTo(index - 1);
    touchStartX.current = null;
  }

  const slide = slides[index];

  return (
    <main className="bleed-top flex flex-1 flex-col bg-white md:mt-0 md:items-center md:justify-center md:bg-primary/5 md:p-8">
      <div
        className="relative flex w-full flex-1 flex-col overflow-hidden bg-white md:h-[min(860px,calc(100dvh-4rem))] md:max-w-[420px] md:flex-none md:rounded-[2.5rem] md:shadow-2xl md:shadow-primary/15"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* hero: all photos stacked so slides crossfade instead of popping */}
        <div className="relative h-[56dvh] min-h-64 w-full shrink-0 bg-primary md:h-[56%]">
          {slides.map((s, i) => (
            <Image
              key={s.image}
              src={s.image}
              alt={i === index ? s.alt : ""}
              aria-hidden={i !== index}
              fill
              sizes="(min-width: 768px) 420px, 100vw"
              preload={i === 0}
              className={`object-cover object-top transition-opacity duration-500 ease-out ${
                i === index ? "opacity-100" : "opacity-0"
              }`}
            />
          ))}
        </div>

        <section
          aria-roledescription="slide"
          aria-label={`${index + 1} of ${slides.length}`}
          className="relative -mt-7 flex flex-1 flex-col rounded-t-[1.75rem] bg-white px-6 pt-6 pb-6 sm:px-8"
        >
          <Dots total={slides.length} current={index} onSelect={goTo} />

          <div
            key={index}
            aria-live="polite"
            className="animate-fade-up mt-4 space-y-2.5 text-center"
          >
            <h1 className="text-[1.625rem] leading-tight font-bold tracking-tight text-foreground">
              {slide.title}
            </h1>
            <p className="mx-auto max-w-xs text-[0.9375rem] leading-relaxed text-muted-foreground">
              {slide.description}
            </p>
          </div>

          <div className="mt-auto flex flex-col gap-3 pt-6">
            {isLast ? (
              <>
                <Link
                  href="/auth/choose-role"
                  onClick={() => setOnboarded()}
                  className={buttonClasses("solid")}
                >
                  Sign Up with Your Phone Number
                </Link>
                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <Link
                    href="/auth/sign-in"
                    onClick={() => setOnboarded()}
                    className="rounded font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Sign In
                  </Link>
                </p>
              </>
            ) : (
              <>
                <Button onClick={handleNext}>Next</Button>
                <Button variant="outline" onClick={handleSkip}>
                  Skip
                </Button>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
