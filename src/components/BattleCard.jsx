// One Battle in a list (Custom tab, My Bets): title, format, stake and pot, its status, and what it
// means for me (invited, in, my payout). Tapping it opens the Battle.

import { Link } from 'react-router-dom';
import { formatMoney } from '../lib/format.js';
import { battleNeedsMe, isExpired, myPart, timeLeft, toMs } from '../lib/battles.js';
import { BATTLE_STATUS_LABELS, FORMAT_LABELS } from '../../shared/battles.js';

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

function myLine(battle, uid) {
  const me = myPart(battle, uid);
  if (!me) return '';
  if (battle.status === 'pending') {
    if (isExpired(battle)) return 'Expired: stakes refunded at the next check';
    if (me.notice === 'payoutChanged') return 'The payout changed: keep your spot or withdraw';
    if (me.status === 'invited') return `You're invited: ${formatMoney(battle.stakeCents)} to join`;
    const waiting = battle.participants.filter((p) => p.status === 'invited').length;
    return `You're in · waiting for ${waiting} more · ${timeLeft(toMs(battle.expiresAt))} left`;
  }
  if (battle.status === 'live') return battle.creatorUid === uid ? "You're in · enter the result when it's over" : "You're in · waiting for the result";
  if (battle.status === 'settled' || battle.status === 'void') {
    const credited = Number(battle.credited?.[uid]) || 0;
    const net = credited - (me.status === 'accepted' ? battle.stakeCents : 0);
    return battle.status === 'void' ? 'Void: stake back' : `Your result ${signedMoney(net)} (paid ${formatMoney(credited)})`;
  }
  return battle.cancelReason || 'Cancelled: stakes refunded';
}

export default function BattleCard({ battle, uid }) {
  const needsMe = battleNeedsMe(battle, uid);
  const count = battle.participants?.length ?? 0;
  return (
    <Link to={`/sportsbook/battles/${encodeURIComponent(battle.id)}`} className={needsMe ? 'card battle-card needs-me' : 'card battle-card'}>
      <div className="battle-card-head">
        <strong className="battle-title">{battle.title}</strong>
        <span className={`battle-status status-${battle.status}`}>{BATTLE_STATUS_LABELS[battle.status] ?? battle.status}</span>
      </div>
      <div className="muted small">
        {FORMAT_LABELS[battle.format]} · {count} players · {formatMoney(battle.stakeCents)} each · pot {formatMoney(battle.potCents)}
        {battle.disputed ? ' · disputed' : ''}
      </div>
      <div className={needsMe ? 'battle-me needs' : 'battle-me'}>{myLine(battle, uid)}</div>
    </Link>
  );
}
