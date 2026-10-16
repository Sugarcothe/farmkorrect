/** Placeholder while a Market, Orders or Sales list is read from the database. */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <main aria-busy="true" aria-label={label} className="flex flex-1 flex-col px-5 pt-16">
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="animate-pulse rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
            <div className="flex justify-between gap-4">
              <div className="h-4 w-40 rounded-full bg-foreground/8" />
              <div className="h-4 w-16 rounded-full bg-foreground/8" />
            </div>
            <div className="mt-2 h-3 w-28 rounded-full bg-foreground/6" />
            <div className="mt-3 h-3 w-2/3 rounded-full bg-foreground/6" />
          </div>
        ))}
      </div>
    </main>
  );
}
