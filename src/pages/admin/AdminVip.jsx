// Admin → VIP (0.28.0): set or change the VIP slot's password, and the machine's proven numbers (read from shared/casino/vipSlots.js).
// The password goes to /api/admin vipSetPassword and is stored only as a salted scrypt hash; this screen never shows it, only when it
// was set. A new password locks everyone out of VIP until they enter it (every pass made before stops working at once).

import { useCallback, useEffect, useState } from 'react';
import { adminAction } from '../../lib/api.js';
import { formatCentralDateTime } from '../../lib/format.js';
import { VIP_BONUS_MAX_SPINS, VIP_BONUS_MULT, VIP_BONUS_SPINS, VIP_MAX_WIN_TIMES, VIP_STATS } from '../../../shared/casino/vipSlots.js';

const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;

export default function AdminVip() {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setStatus(await adminAction('vipStatus'));
    } catch (err) {
      setLoadError(err.message || 'Could not load the VIP status.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(event) {
    event.preventDefault();
    setError('');
    setDone('');
    if (password.length < 6) {
      setError('Use at least 6 characters.');
      return;
    }
    if (password !== repeat) {
      setError("The two passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      const data = await adminAction('vipSetPassword', { password, repeat });
      setPassword('');
      setRepeat('');
      setStatus({ ok: true, setUp: true, updatedAt: data.updatedAt });
      setDone('Saved. Everyone has to enter the new password the next time they open VIP.');
    } catch (err) {
      setError(err.message || 'Could not save the password.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page vip-admin">
      <div className="card">
        <h3>VIP password</h3>
        {loadError ? <p className="error-text small">{loadError}</p> : null}
        {status === null && !loadError ? <p className="muted small">Loading…</p> : null}
        {status ? (
          <p className="small" data-testid="vip-status">
            {status.setUp ? `Password set on ${formatCentralDateTime(status.updatedAt)}` : "No password yet: VIP is locked for everyone (\"VIP isn't set up yet\")."}
          </p>
        ) : null}
        <form className="form-grid" onSubmit={save} autoComplete="off">
          <label className="field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={saving} />
          </label>
          <label className="field">
            <span>Repeat</span>
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={saving} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={saving || !password || !repeat}>
            {saving ? 'Saving…' : status?.setUp ? 'Change password' : 'Set password'}
          </button>
          {error ? (
            <p className="error-text small" role="alert">
              {error}
            </p>
          ) : null}
          {done ? <p className="success-text small">{done}</p> : null}
        </form>
        <p className="muted small">
          Stored only as a salted hash; nobody can read it back, not even here. Players enter it every time they open VIP; changing it
          signs everyone out of VIP at once.
        </p>
      </div>

      <div className="card">
        <h3>The machine (proven numbers)</h3>
        <dl className="agent-stats vip-stats">
          <div>
            <dt>Total RTP</dt>
            <dd>{pct(VIP_STATS.totalRtp)}</dd>
          </div>
          <div>
            <dt>Lines</dt>
            <dd>{pct(VIP_STATS.baseRtp)}</dd>
          </div>
          <div>
            <dt>Bonus</dt>
            <dd>{pct(VIP_STATS.bonusRtp)}</dd>
          </div>
          <div>
            <dt>Something back</dt>
            <dd>{pct(VIP_STATS.hitRate, 1)}</dd>
          </div>
          <div>
            <dt>5× or more</dt>
            <dd>{pct(VIP_STATS.bigRate, 1)}</dd>
          </div>
          <div>
            <dt>Bonus every</dt>
            <dd>{VIP_STATS.triggerEvery} spins</dd>
          </div>
          <div>
            <dt>Bonus worth</dt>
            <dd>{VIP_STATS.bonusValueTimes.toFixed(1)}× bet</dd>
          </div>
          <div>
            <dt>Biggest spin</dt>
            <dd>{VIP_STATS.maxPaidSpinTimes.toLocaleString('en-US')}× bet</dd>
          </div>
        </dl>
        <p className="muted small">
          Exact over all {VIP_STATS.combos.toLocaleString('en-US')} stop combinations. Bonus: {VIP_BONUS_SPINS} free spins, wins ×
          {VIP_BONUS_MULT}, retriggers up to {VIP_BONUS_MAX_SPINS} spins; a spin never pays more than{' '}
          {VIP_MAX_WIN_TIMES.toLocaleString('en-US')}× the bet. These numbers are deliberate (see CLAUDE.md): don't "fix" the RTP.
        </p>
      </div>
    </div>
  );
}
