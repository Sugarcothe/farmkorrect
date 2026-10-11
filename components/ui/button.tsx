import type { ButtonHTMLAttributes } from "react";

type Variant = "solid" | "outline" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** shows a spinner and blocks repeat submits */
  loading?: boolean;
};

const base =
  "flex h-12 w-full items-center justify-center rounded-full px-5 text-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  solid: "bg-primary text-primary-foreground hover:bg-primary-dark",
  outline: "border border-primary bg-white text-primary hover:bg-primary/5",
  ghost: "text-foreground/60 hover:text-foreground",
};

// lets links that navigate (e.g. <Link>) share the button look
export function buttonClasses(variant: Variant = "solid", className = "") {
  return `${base} ${variants[variant]} ${className}`;
}

export function Button({
  variant = "solid",
  className = "",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonClasses(
        variant,
        `${loading ? "disabled:opacity-80" : ""} ${className}`,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="mr-2.5 size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {children}
    </button>
  );
}
