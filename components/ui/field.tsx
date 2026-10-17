"use client";

import { useId, useState } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "@/components/ui/icons";

type FieldShellProps = {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  /** grows to fit a textarea instead of the single-line height */
  multiline?: boolean;
  children: ReactNode;
};

function FieldShell({
  id,
  label,
  error,
  hint,
  className = "",
  multiline = false,
  children,
}: FieldShellProps) {
  const message = error ?? hint;
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[0.8125rem] font-semibold text-foreground"
      >
        {label}
      </label>
      <div
        className={`flex gap-2.5 rounded-xl ${multiline ? "items-start py-3" : "h-12 items-center"} border bg-white px-3.5 transition-[border-color,box-shadow] focus-within:ring-3 ${
          error
            ? "border-red-500 focus-within:ring-red-500/15"
            : "border-foreground/12 focus-within:border-accent focus-within:ring-accent/15"
        }`}
      >
        {children}
      </div>
      {message && (
        <p
          id={`${id}-message`}
          className={`mt-1.5 text-xs ${error ? "font-medium text-red-600" : "text-muted-foreground"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}

const controlClass =
  "h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-foreground/35";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "name"> & {
  name: string;
  label: string;
  icon?: IconName;
  error?: string;
  hint?: string;
};

/** Labelled input; `type="password"` adds a show/hide toggle. */
export function TextField({
  label,
  icon,
  error,
  hint,
  type = "text",
  id,
  className,
  ...props
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";

  return (
    <FieldShell
      id={inputId}
      label={label}
      error={error}
      hint={hint}
      className={className}
    >
      {icon && (
        <Icon name={icon} className="size-[18px] shrink-0 text-foreground/40" />
      )}
      <input
        id={inputId}
        type={isPassword && revealed ? "text" : type}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-message` : undefined}
        className={controlClass}
        {...props}
      />
      {isPassword && (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? "Hide password" : "Show password"}
          aria-pressed={revealed}
          className="-mr-1.5 rounded-lg p-1.5 text-foreground/45 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon name={revealed ? "eye-off" : "eye"} className="size-[18px]" />
        </button>
      )}
    </FieldShell>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "name"> & {
  name: string;
  label: string;
  error?: string;
  hint?: string;
};

export function TextAreaField({ label, error, hint, id, className, ...props }: TextAreaFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <FieldShell id={inputId} label={label} error={error} hint={hint} className={className} multiline>
      <textarea
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-message` : undefined}
        className="min-h-24 w-full min-w-0 flex-1 resize-y bg-transparent text-base leading-relaxed text-foreground outline-none placeholder:text-foreground/35"
        {...props}
      />
    </FieldShell>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "name"> & {
  name: string;
  label: string;
  error?: string;
  hint?: string;
  placeholder: string;
  options: ReadonlyArray<{ value: string; label: string }>;
};

export function SelectField({
  label,
  error,
  hint,
  placeholder,
  options,
  id,
  className,
  value,
  ...props
}: SelectFieldProps) {
  const autoId = useId();
  const selectId = id ?? autoId;

  return (
    <FieldShell
      id={selectId}
      label={label}
      error={error}
      hint={hint}
      className={className}
    >
      <select
        id={selectId}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${selectId}-message` : undefined}
        className={`${controlClass} cursor-pointer appearance-none ${value ? "" : "text-foreground/35"}`}
        {...props}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="text-foreground">
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none size-[18px] shrink-0 text-foreground/50"
      />
    </FieldShell>
  );
}
