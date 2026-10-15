// Shown while wallet balances and history are read from the ledger.
export default function WalletLoading() {
  return (
    <main aria-busy="true" aria-label="Loading your wallet" className="flex flex-1 flex-col gap-5 px-5 pt-14">
      <div className="h-40 animate-pulse rounded-3xl bg-primary/15" />
      <div className="grid animate-pulse grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="h-24 rounded-2xl bg-white shadow-sm ring-1 ring-foreground/5" />
        ))}
      </div>
      <div className="animate-pulse rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
        {[0, 1, 2].map((n) => (
          <div key={n} className="flex items-center gap-3 py-2.5">
            <div className="size-9 rounded-xl bg-foreground/8" />
            <div className="flex-1">
              <div className="h-3.5 w-40 rounded-full bg-foreground/8" />
              <div className="mt-2 h-3 w-24 rounded-full bg-foreground/6" />
            </div>
            <div className="h-4 w-16 rounded-full bg-foreground/8" />
          </div>
        ))}
      </div>
    </main>
  );
}
