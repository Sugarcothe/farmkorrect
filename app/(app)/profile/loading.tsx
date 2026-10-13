// Shown while the profile is read from the database.
export default function ProfileLoading() {
  return (
    <main aria-busy="true" aria-label="Loading your profile" className="flex flex-1 flex-col px-5 pt-14">
      <div className="flex animate-pulse flex-col items-center rounded-3xl bg-white px-5 pt-6 pb-5 shadow-sm ring-1 ring-foreground/5">
        <div className="size-24 rounded-full bg-foreground/8" />
        <div className="mt-4 h-5 w-40 rounded-full bg-foreground/8" />
        <div className="mt-2 h-3.5 w-28 rounded-full bg-foreground/6" />
        <div className="mt-3 h-6 w-32 rounded-full bg-foreground/6" />
      </div>
      <div className="mt-5 animate-pulse overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <div className="size-9 rounded-xl bg-foreground/6" />
            <div className="h-3.5 w-32 rounded-full bg-foreground/6" />
          </div>
        ))}
      </div>
    </main>
  );
}
