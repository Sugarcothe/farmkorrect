// Placeholder for the add/edit service form while its page loads.
export function ServiceFormSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading" className="flex flex-1 animate-pulse flex-col px-5 pt-16">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="mb-4">
          <div className="mb-2 h-3 w-24 rounded-full bg-foreground/8" />
          <div className={`${i === 2 ? "h-28" : "h-12"} rounded-xl bg-white ring-1 ring-foreground/8`} />
        </div>
      ))}
    </main>
  );
}
