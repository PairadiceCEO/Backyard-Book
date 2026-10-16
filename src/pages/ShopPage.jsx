// Free play money. The wallet in the nav updates by itself through the Firestore listener.

import { useState } from 'react';
import { apiRequest, makeRequestId } from '../lib/api.js';
import { formatMoney } from '../lib/format.js';
import { SHOP_AMOUNTS_DOLLARS } from '../../shared/constants.js';

export default function ShopPage() {
  const [pendingAmount, setPendingAmount] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function buy(amount) {
    setPendingAmount(amount);
    setMessage('');
    setError('');
    try {
      const result = await apiRequest('/api/shop', {
        method: 'POST',
        body: { amount, clientRequestId: makeRequestId() },
      });
      setMessage(`Added $${amount}. New balance: ${formatMoney(result.balanceCents)}.`);
    } catch (err) {
      setError(err.message || 'Could not add money. Try again.');
    } finally {
      setPendingAmount(null);
    }
  }

  const busy = pendingAmount !== null;

  return (
    <section className="page">
      <h2 className="section-title">Shop</h2>
      <p className="muted">Add free play money to your wallet.</p>
      <div className="shop-grid">
        {SHOP_AMOUNTS_DOLLARS.map((amount) => (
          <button
            key={amount}
            type="button"
            className="shop-button"
            disabled={busy}
            onClick={() => buy(amount)}
          >
            {pendingAmount === amount ? 'Adding…' : `+$${amount}`}
          </button>
        ))}
      </div>
      {message ? <p className="success-text" role="status">{message}</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </section>
  );
}
