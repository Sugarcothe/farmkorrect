type DotsProps = {
  total: number;
  current: number;
  onSelect?: (index: number) => void;
};

export function Dots({ total, current, onSelect }: DotsProps) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }).map((_, i) => {
        const active = i === current;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelect?.(i)}
            disabled={!onSelect}
            aria-label={`Go to slide ${i + 1} of ${total}`}
            aria-current={active ? "step" : undefined}
            className="flex h-6 items-center rounded-full px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span
              className={`block h-2 rounded-full transition-all duration-300 ${
                active ? "w-6 bg-primary" : "w-2 bg-primary/20"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
