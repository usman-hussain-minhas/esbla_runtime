export default function ExpensesLoading() {
  return (
    <section aria-busy="true" aria-live="polite" className="work-surface">
      <p className="surface-label">Expense Claim Boundary</p>
      <h1>Loading Expense Claims</h1>
      <p>Checking current service, role, and claim authority.</p>
    </section>
  );
}
