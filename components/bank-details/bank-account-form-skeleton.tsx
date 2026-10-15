/** Placeholder for the bank account form while it (or its bank list) loads. */
export function BankAccountFormSkeleton({ fieldsOnly = false }: { fieldsOnly?: boolean }) {
  const fields = (
    <div className="animate-pulse space-y-4" aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i}>
          <div className="h-3.5 w-28 rounded-full bg-foreground/8" />
          <div className="mt-2 h-12 rounded-xl bg-white ring-1 ring-foreground/8" />
        </div>
      ))}
    </div>
  );
  if (fieldsOnly) return fields;
  return (
    <main aria-busy="true" aria-label="Loading" className="flex flex-1 flex-col px-5 pt-14">
      <div className="mb-6 animate-pulse">
        <div className="h-3.5 w-full rounded-full bg-foreground/6" />
        <div className="mt-2 h-3.5 w-2/3 rounded-full bg-foreground/6" />
      </div>
      {fields}
    </main>
  );
}
