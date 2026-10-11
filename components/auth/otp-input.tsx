"use client";

import { useRef } from "react";

type OtpInputProps = {
  value: string[];
  onChange: (digits: string[]) => void;
  invalid?: boolean;
  disabled?: boolean;
  labelledBy: string;
  describedBy?: string;
};

/** One box per digit with auto-advance, backspace, arrow keys and paste. */
export function OtpInput({
  value,
  onChange,
  invalid,
  disabled,
  labelledBy,
  describedBy,
}: OtpInputProps) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const length = value.length;

  function focusAt(i: number) {
    inputs.current[Math.max(0, Math.min(length - 1, i))]?.focus();
  }

  // spreads digits from `start`, e.g. a pasted or autofilled code
  function fillFrom(start: number, text: string) {
    const chars = text.replace(/\D/g, "").slice(0, length - start).split("");
    if (!chars.length) return;
    const next = [...value];
    chars.forEach((c, k) => (next[start + k] = c));
    onChange(next);
    focusAt(start + chars.length);
  }

  function handleChange(i: number, raw: string) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length > 2) return fillFrom(i, digits);
    const next = [...value];
    next[i] = digits.slice(-1);
    onChange(next);
    if (next[i]) focusAt(i + 1);
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !value[i] && i > 0) {
      e.preventDefault();
      const next = [...value];
      next[i - 1] = "";
      onChange(next);
      focusAt(i - 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(length - 1);
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="flex justify-center gap-2 sm:gap-2.5"
    >
      {value.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            inputs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={digit}
          onFocus={(e) => e.target.select()}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={(e) => {
            e.preventDefault();
            fillFrom(i, e.clipboardData.getData("text"));
          }}
          className={`size-12 min-w-0 rounded-xl border bg-white text-center text-xl font-semibold text-foreground caret-accent outline-none transition-[border-color,box-shadow] focus:ring-3 disabled:opacity-60 sm:size-[52px] ${
            invalid
              ? "border-red-500 focus:ring-red-500/15"
              : digit
                ? "border-foreground/25 focus:border-accent focus:ring-accent/15"
                : "border-foreground/12 focus:border-accent focus:ring-accent/15"
          }`}
        />
      ))}
    </div>
  );
}
