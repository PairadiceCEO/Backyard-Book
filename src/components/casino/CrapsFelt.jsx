// The craps felt drawn like a real table (0.18.0). Every printed area is one <button> that calls the same tap handler the
// old spots used (place a chip, or take the bet down), so nothing about betting lives here: this file only draws.
//
// One DOM, two layouts. CSS (src/styles/craps.css) arranges the same areas upright (stacked, phone held upright) and
// sideways (a long table with the Pass Line down the left edge); rotating the phone never remounts anything.
//   Pass Line and Don't Pass Bar exist twice: the long vertical strips down the left edge (sideways, wide enough) and the
//   rows along the bottom. They are the same bet (the strips are a second place to tap, hidden from screen readers).
//   Place numbers: payout small at the top, the number, the ON puck bottom-left, my chips bottom-right. A Come bet that
//   moved to a number shows as a chip marked C with its Odds chip beside it; tapping that cluster adds Come Odds.

import Die from './Die.jsx';
import { FeltChip } from './FeltChip.jsx';
import { formatMoney } from '../../lib/format.js';

const NUMBER_WORD = { 6: 'SIX', 9: 'NINE' };
const NUMBER_NAME = { 6: 'Six', 9: 'Nine' };
const HARD_ORDER = [6, 10, 8, 4]; // the printed order: 3-3, 5-5, 4-4, 2-2

const ratio = ([n, d]) => `${n}:${d}`;
const toOne = ([n, d]) => `${n} to ${d}`;

// A felt button: aria-label, the amount on it as a chip, the blocked look. `strip` = the duplicate long edge button.
function Area({ kind, number, label, cents = 0, blocked, onTap, disabled, className = '', strip = false, children }) {
  const key = number === undefined ? kind : `${kind}:${number}`;
  const classes = ['fa', className, cents ? 'has-bet' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={classes}
      data-spot={key}
      data-part={strip ? 'strip' : undefined}
      aria-label={`${label}${cents ? `, ${formatMoney(cents)} on it` : ''}`}
      aria-hidden={strip ? 'true' : undefined}
      tabIndex={strip ? -1 : undefined}
      disabled={disabled}
      onClick={() => onTap(kind, number)}
    >
      {children}
      {cents ? <FeltChip cents={cents} className="fa-chip" /> : null}
    </button>
  );
}

export default function CrapsFelt({ variant, point, bets, takeDown, oddsMax, dontOddsMax, blockedOf, onTap, disabled = false }) {
  const dontPass = Boolean(variant.dontPass);
  const odds = point ? variant.odds[point] : null;
  const common = (kind, number) => ({ kind, number, blocked: blockedOf(kind, number), onTap, disabled });
  const passLabel = 'Pass Line, pays 1:1';
  const dontLabel = "Don't Pass Bar, pays 1:1, 12 pushes";

  return (
    <div className={`craps-felt felt-${variant.id}${takeDown ? ' taking-down' : ''}`} data-variant={variant.id}>
      <div className="felt-board">
        <Area {...common('pass')} label={passLabel} cents={bets.pass} className="a-pass-strip" strip>
          <span className="fl">Pass Line</span>
        </Area>
        {dontPass ? (
          <Area {...common('dontPass')} label={dontLabel} cents={bets.dontPass} className="a-dont-strip" strip>
            <span className="fl">Don’t Pass Bar</span>
          </Area>
        ) : null}

        <div className="felt-nums" role="group" aria-label="Place numbers">
          {variant.points.map((n) => {
            const come = bets.comeOn[n];
            const name = NUMBER_NAME[n] ?? String(n);
            const placed = bets.place[n] ?? 0;
            return (
              <div key={n} className={['fn', point === n ? 'is-point' : '', come ? 'has-come' : ''].filter(Boolean).join(' ')}>
                <Area
                  {...common('place', n)}
                  label={`Place ${name}, pays ${ratio(variant.place[n])}${point ? '' : ', off on the come-out'}`}
                  cents={placed}
                  className="fn-main"
                >
                  <span className="fn-pay">{ratio(variant.place[n])}</span>
                  <span className="fn-num" style={{ '--len': String(NUMBER_WORD[n]?.length ?? String(n).length) }}>
                    {NUMBER_WORD[n] ?? n}
                  </span>
                  {point === n ? <span className="fn-puck">ON</span> : null}
                </Area>
                {come ? (
                  <button
                    type="button"
                    className={['fn-come', come.odds ? 'has-bet' : '', blockedOf('comeOdds', n) ? 'blocked' : ''].filter(Boolean).join(' ')}
                    data-spot={`comeOdds:${n}`}
                    disabled={disabled}
                    onClick={() => onTap('comeOdds', n)}
                    aria-label={`Come bet ${formatMoney(come.bet)} on ${name}${come.odds ? `, Odds ${formatMoney(come.odds)}` : ''}; tap for Odds (${ratio(variant.odds[n])}, at most ${formatMoney(come.bet * variant.oddsMultiple)})${point ? '' : ', off on the come-out'}`}
                  >
                    <FeltChip cents={come.bet} mark="C" className="come-chip" />
                    {come.odds ? <FeltChip cents={come.odds} className="odds-chip" /> : null}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        <Area {...common('come')} label="Come, pays 1:1" cents={bets.come} className="a-come">
          <span className="fl">Come</span>
        </Area>

        <Area {...common('field')} label="Field: 3, 4, 9, 10, 11 pay 1:1; 2 and 12 pay 2:1" cents={bets.field} className="a-field">
          <span className="ff-nums" aria-hidden="true">
            <i className="ring">2</i>
            <b>·</b>3<b>·</b>4<b>·</b>9<b>·</b>10<b>·</b>11<b>·</b>
            <i className="ring">12</i>
          </span>
          <span className="ff-name">
            Field <small>· 2 and 12 pay double</small>
          </span>
        </Area>

        {dontPass ? (
          <div className="fp fp-dont">
            <Area {...common('dontPass')} label={dontLabel} cents={bets.dontPass} className="a-dont">
              <span className="fl">Don’t Pass Bar</span>
              <small className="fl-sub">12 pushes</small>
            </Area>
            <Area
              {...common('dontOdds')}
              label={
                point
                  ? `Don't Pass Odds on ${point}, at most ${formatMoney(dontOddsMax ?? 0)} (${variant.oddsMultiple}× Don't Pass)`
                  : "Don't Pass Odds, once a Point is set"
              }
              cents={bets.dontOdds}
              className="a-dodds"
            >
              <span className="fl">Don’t Odds</span>
            </Area>
          </div>
        ) : null}

        <div className="fp fp-pass">
          <Area {...common('pass')} label={passLabel} cents={bets.pass} className="a-pass">
            <span className="fl">Pass Line</span>
          </Area>
          <Area
            {...common('odds')}
            label={
              point
                ? `Odds on ${point}, pays ${odds ? ratio(odds) : ''}, at most ${formatMoney(oddsMax ?? 0)} (${variant.oddsMultiple}× Pass)`
                : 'Odds behind Pass, once a Point is set'
            }
            cents={bets.odds}
            className="a-odds"
          >
            <span className="fl">Odds</span>
            <small className="fl-sub">up to {variant.oddsMultiple}×</small>
          </Area>
        </div>

        <div className="felt-hard" role="group" aria-label="Hard ways">
          <h3 className="fh-head">Hardways</h3>
          <div className="fh-grid">
            {HARD_ORDER.filter((n) => variant.hardWays[n]).map((n) => (
              <Area
                key={n}
                {...common('hard', n)}
                label={`Hard ${n} (${n / 2} and ${n / 2}), pays ${ratio(variant.hardWays[n])}`}
                cents={bets.hard[n] ?? 0}
                className="fh-box"
              >
                <span className="fh-dice">
                  <Die value={n / 2} className="red" decorative />
                  <Die value={n / 2} className="red" decorative />
                </span>
                <span className="fh-pay">{toOne(variant.hardWays[n])}</span>
              </Area>
            ))}
          </div>
          <p className="fh-note">Odds pay true odds</p>
        </div>
      </div>
    </div>
  );
}
