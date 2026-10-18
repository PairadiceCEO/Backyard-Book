import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import BattleCard from '../components/BattleCard.jsx';
import BetCard from '../components/BetCard.jsx';
import CashoutConfirmModal from '../components/CashoutConfirmModal.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews.jsx';
import { useWalletDisplay } from '../context/WalletDisplayContext.jsx';
import { useBattles } from '../context/BattlesContext.jsx';
import { isFinished } from '../lib/battles.js';
import { useCashoutQuotes } from '../hooks/useCashoutQuotes.js';
import { useMyBets } from '../hooks/useMyBets.js';
import { usePolling } from '../hooks/usePolling.js';
import { apiRequest } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';
import { requestSettlement } from '../lib/settle.js';
import { cashoutEligible } from '../../shared/betRules.js';

const SETTLE_CHECK_MS = 60 * 1000;

export default function MyBetsPage() {
  const { bets, error, loading, retry } = useMyBets();
  // Battles I'm in (the same live list as the Custom tab): open ones with Active, the rest with Finished.
  const { battles, uid: myUid } = useBattles();
  const activeBattles = battles.filter((b) => !isFinished(b));
  const finishedBattles = battles.filter(isFinished);
  const { reportBalance } = useWalletDisplay();

  // On load and every minute while this page is visible, ask the server to settle finished games.
  // Results arrive through the live bets listener; requestSettlement is a stable module function.
  usePolling(requestSettlement, SETTLE_CHECK_MS, 'my-bets');

  const { active, finished } = useMemo(
    () => ({
      active: bets.filter((b) => b.status === 'open'),
      finished: bets.filter((b) => b.status !== 'open'),
    }),
    [bets],
  );

  // Cash out: estimates for every open bet that can be cashed out (never one with a custom-game, Challenge or
  // crypto leg), then confirm → server re-prices → pay (or CASHOUT_CHANGED).
  const activeIds = useMemo(() => active.filter(cashoutEligible).map((b) => b.id), [active]);
  const { quotes, setQuote, refresh: refreshQuotes } = useCashoutQuotes(activeIds);
  const [cashout, setCashout] = useState(null); // { bet, valueCents, previousCents, busy, error, unavailable }
  const [cashedNote, setCashedNote] = useState('');

  const startCashout = useCallback((bet, valueCents) => {
    setCashedNote('');
    setCashout({ bet, valueCents, previousCents: null, busy: false, error: '', unavailable: '' });
  }, []);

  const closeCashout = useCallback(() => setCashout(null), []);

  const confirmCashout = useCallback(async () => {
    if (!cashout || cashout.busy) return;
    const { bet, valueCents } = cashout;
    setCashout((c) => (c ? { ...c, busy: true, error: '' } : c));
    try {
      const result = await apiRequest('/api/bets', { method: 'POST', body: { action: 'cashout', betId: bet.id, expectedCents: valueCents } });
      reportBalance(result.balanceCents);
      setCashout(null);
      setCashedNote(`Cashed out ${formatMoney(result.cashoutCents)} · new balance ${formatMoney(result.balanceCents)}`);
    } catch (err) {
      if (err.code === 'CASHOUT_CHANGED' && Number.isInteger(err.details?.valueCents)) {
        const next = err.details.valueCents;
        setQuote(bet.id, { available: true, valueCents: next, mode: quotes[bet.id]?.mode ?? 'live' });
        setCashout((c) => (c ? { ...c, busy: false, previousCents: valueCents, valueCents: next } : c));
      } else if (err.code === 'CASHOUT_UNAVAILABLE') {
        const reason = err.details?.reason || err.message || 'Cash out unavailable right now';
        setQuote(bet.id, { available: false, valueCents: null, reason });
        setCashout((c) => (c ? { ...c, busy: false, unavailable: reason } : c));
        refreshQuotes();
      } else {
        setCashout((c) => (c ? { ...c, busy: false, error: err.message || 'Cash out failed. Try again.' } : c));
      }
    }
  }, [cashout, quotes, reportBalance, setQuote, refreshQuotes]);

  if (loading) {
    return (
      <section className="page">
        <h2 className="section-title">My Bets</h2>
        <LoadingState label="Loading your bets…" rows={3} />
      </section>
    );
  }

  if (error) {
    return (
      <section className="page">
        <h2 className="section-title">My Bets</h2>
        <ErrorState title="Couldn't load your bets" message={error} onRetry={retry} />
      </section>
    );
  }

  if (bets.length === 0 && battles.length === 0) {
    return (
      <section className="page">
        <h2 className="section-title">My Bets</h2>
        <EmptyState
          icon="🎟️"
          title="No bets yet"
          action={
            <Link to="/sportsbook" className="btn btn-primary">
              Go to the Sportsbook
            </Link>
          }
        >
          Tap any price on the board to add it to your bet slip. Your bets show up here, and settle on their own when games end.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page">
      <h2 className="section-title">Active ({active.length + activeBattles.length})</h2>
      {active.length === 0 && activeBattles.length === 0 ? (
        <EmptyState title="No active bets">Everything you've bet on has finished. Pick a price on the Sportsbook to start a slip.</EmptyState>
      ) : null}
      {cashedNote ? (
        <p className="success-text small" role="status">
          {cashedNote}
        </p>
      ) : null}
      {active.map((bet) => (
        <BetCard key={bet.id} bet={bet} cashout={quotes[bet.id] ?? null} onCashOut={cashoutEligible(bet) ? startCashout : null} />
      ))}

      {activeBattles.length ? <h3 className="day-label">Battles</h3> : null}
      {activeBattles.map((b) => (
        <BattleCard key={b.id} battle={b} uid={myUid} />
      ))}

      <h2 className="section-title">Finished ({finished.length + finishedBattles.length})</h2>
      {finished.length === 0 && finishedBattles.length === 0 ? (
        <EmptyState title="Nothing settled yet">Bets settle automatically once their games are final.</EmptyState>
      ) : null}
      {finished.map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}
      {finishedBattles.length ? <h3 className="day-label">Battles</h3> : null}
      {finishedBattles.map((b) => (
        <BattleCard key={b.id} battle={b} uid={myUid} />
      ))}

      {cashout ? (
        <CashoutConfirmModal
          bet={cashout.bet}
          valueCents={cashout.valueCents}
          previousCents={cashout.previousCents}
          busy={cashout.busy}
          error={cashout.error}
          unavailable={cashout.unavailable}
          onConfirm={confirmCashout}
          onClose={closeCashout}
        />
      ) : null}
    </section>
  );
}
