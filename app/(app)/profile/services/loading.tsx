// Shown while the service list is read from the database.
export default function ServicesLoading() {
  return (
    <main aria-busy="true" aria-label="Loading your services" className="flex flex-1 flex-col px-5 pt-14">
      <div className="animate-pulse">
        <div className="h-5 w-52 rounded-full bg-foreground/8" />
        <div className="mt-3 h-3.5 w-full rounded-full bg-foreground/6" />
        <div className="mt-2 h-3.5 w-3/4 rounded-full bg-foreground/6" />
        <div className="mt-5 h-12 rounded-full bg-foreground/8" />
      </div>
      <div className="mt-6 space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="animate-pulse rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
            <div className="flex justify-between gap-4">
              <div className="h-4 w-40 rounded-full bg-foreground/8" />
              <div className="h-4 w-16 rounded-full bg-foreground/8" />
            </div>
            <div className="mt-2 h-3 w-24 rounded-full bg-foreground/6" />
            <div className="mt-4 h-3 w-full rounded-full bg-foreground/6" />
            <div className="mt-2 h-3 w-2/3 rounded-full bg-foreground/6" />
            <div className="mt-4 flex gap-2">
              <div className="h-6 w-20 rounded-full bg-foreground/6" />
              <div className="h-6 w-36 rounded-full bg-foreground/6" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
