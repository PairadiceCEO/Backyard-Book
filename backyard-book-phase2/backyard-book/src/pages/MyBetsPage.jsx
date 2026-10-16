export default function MyBetsPage() {
  return (
    <section className="page">
      <h2 className="section-title">Active</h2>
      <div className="card empty-state">
        <p className="muted">No active bets. Betting opens in Phase 6.</p>
      </div>
      <h2 className="section-title">Finished</h2>
      <div className="card empty-state">
        <p className="muted">No finished bets yet.</p>
      </div>
    </section>
  );
}
