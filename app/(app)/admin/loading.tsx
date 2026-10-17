// Shown while an admin page reads its queue from the database.
export default function AdminLoading() {
  return (
    <main aria-busy="true" aria-label="Loading" className="flex flex-1 flex-col gap-5 px-5 pt-14">
      <div className="grid animate-pulse grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="h-24 rounded-2xl bg-white shadow-sm ring-1 ring-foreground/5" />
        ))}
      </div>
      <div className="animate-pulse rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
        {[0, 1, 2].map((n) => (
          <div key={n} className="py-2.5">
            <div className="h-3.5 w-40 rounded-full bg-foreground/8" />
            <div className="mt-2 h-3 w-24 rounded-full bg-foreground/6" />
          </div>
        ))}
      </div>
    </main>
  );
}
