"use client";

import { useId } from "react";

type SwitchProps = {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** a change is being saved; the switch is locked until it settles */
  busy?: boolean;
};

/** An on/off control with a visible label (role="switch"). */
export function Switch({ label, description, checked, onChange, disabled, busy }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {label}
        </label>
        {description && (
          <p id={`${id}-description`} className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed ${
          checked ? "bg-primary" : "bg-foreground/20"
        } ${disabled && !busy ? "opacity-50" : ""}`}
      >
        <span
          aria-hidden="true"
          className={`flex size-6 items-center justify-center rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        >
          {busy && (
            <span className="size-3 animate-spin rounded-full border-2 border-primary border-r-transparent" />
          )}
        </span>
      </button>
    </div>
  );
}
