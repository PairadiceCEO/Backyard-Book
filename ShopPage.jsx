import { SHOP_AMOUNTS_DOLLARS } from '../../shared/constants.js';

export default function ShopPage() {
  return (
    <section className="page">
      <h2 className="section-title">Shop</h2>
      <p className="muted">Add free play money to your wallet. The buttons turn on in Phase 3.</p>
      <div className="shop-grid">
        {SHOP_AMOUNTS_DOLLARS.map((amount) => (
          <button key={amount} type="button" className="shop-button" disabled>
            +${amount}
          </button>
        ))}
      </div>
    </section>
  );
}
