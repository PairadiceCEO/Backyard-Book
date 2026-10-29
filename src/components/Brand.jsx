// The Pairadice brand (0.27.0): the dice mark (one component, HouseChip.jsx) and the "PAIRADICE" wordmark in Cinzel with the gold
// gradient fill, with a small tag line under it. Used by the top bar and the login and setup pages.
//   <BrandMark size />     the dice mark alone
//   <Wordmark tag />       "PAIRADICE" + tag line (tag = 'SPORTSBOOK' | 'CASINO' | '' for none)
//   <BrandLockup ... />    mark + wordmark side by side (top bar)
//   <BrandHero />          the login page: big mark, wordmark, "CASINO · SPORTSBOOK" between two thin gold rules

import { PairadiceMark } from './casino/HouseChip.jsx';

export function BrandMark({ size = 34, className = '' }) {
  return <PairadiceMark size={size} className={['brand-mark', className].filter(Boolean).join(' ')} />;
}

export function Wordmark({ tag = '', className = '' }) {
  return (
    <span className={['wordmark', className].filter(Boolean).join(' ')}>
      <span className="wordmark-name">PAIRADICE</span>
      {tag ? <span className="wordmark-tag">{tag}</span> : null}
    </span>
  );
}

export function BrandLockup({ tag = 'SPORTSBOOK', size = 34 }) {
  return (
    <span className="brand" aria-label={`Pairadice ${tag.toLowerCase()}`}>
      <BrandMark size={size} />
      <Wordmark tag={tag} />
    </span>
  );
}

export function BrandHero() {
  return (
    <div className="brand-hero">
      <BrandMark size={64} />
      <span className="wordmark wordmark-large">
        <span className="wordmark-name">PAIRADICE</span>
      </span>
      <span className="brand-rules">
        <span className="brand-rule" aria-hidden="true" />
        <span className="wordmark-tag">CASINO · SPORTSBOOK</span>
        <span className="brand-rule" aria-hidden="true" />
      </span>
    </div>
  );
}
