// Shown while the payout account is read from the database.
export default function BankDetailsLoading() {
  return (
    <main aria-busy="true" aria-label="Loading your bank details" className="flex flex-1 flex-col px-5 pt-14">
      <div className="animate-pulse">
        <div className="h-5 w-40 rounded-full bg-foreground/8" />
        <div className="mt-3 h-3.5 w-full rounded-full bg-foreground/6" />
        <div className="mt-2 h-3.5 w-3/4 rounded-full bg-foreground/6" />
        <div className="mt-5 h-12 rounded-xl bg-foreground/6" />
      </div>
      <div className="mt-5 animate-pulse rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
        <div className="flex gap-3">
          <div className="size-11 rounded-2xl bg-foreground/8" />
          <div className="flex-1">
            <div className="h-4 w-40 rounded-full bg-foreground/8" />
            <div className="mt-2 h-3.5 w-20 rounded-full bg-foreground/6" />
          </div>
        </div>
        <div className="mt-5 h-3 w-24 rounded-full bg-foreground/6" />
        <div className="mt-2 h-4 w-48 rounded-full bg-foreground/8" />
        <div className="mt-4 h-6 w-56 rounded-full bg-foreground/6" />
        <div className="mt-5 h-12 rounded-full bg-foreground/6" />
      </div>
    </main>
  );
}
