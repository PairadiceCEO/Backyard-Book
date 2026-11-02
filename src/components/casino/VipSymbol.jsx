// The VIP slot's symbols (0.28.0), drawn as inline SVG in the Pairadice black and gold: Crown, Gold 7, Diamond, Gold Bar, Bell,
// Cherry, Blank and the Golden Dice (the Pairadice dice mark on a gold tile). Every SVG id is unique per instance (useId).

import { useId } from 'react';
import { PairadiceMarkShapes } from './HouseChip.jsx';
import { VIP_SYMBOLS } from '../../../shared/casino/vipSlots.js';

function Gold({ id }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#fff1c2" />
      <stop offset="45%" stopColor="#e2bd62" />
      <stop offset="100%" stopColor="#9c6f24" />
    </linearGradient>
  );
}

function Shape({ id, g, uid }) {
  const fill = `url(#${g})`;
  switch (id) {
    case 'CR':
      return (
        <g>
          <path d="M10 44 L6 18 L19 30 L32 12 L45 30 L58 18 L54 44 Z" fill={fill} stroke="#5a3d0c" strokeWidth="1.5" strokeLinejoin="round" />
          <rect x="10" y="45" width="44" height="7" rx="2" fill={fill} stroke="#5a3d0c" strokeWidth="1.5" />
          <circle cx="32" cy="12" r="3.2" fill="#fff6d6" />
          <circle cx="6" cy="18" r="2.6" fill="#fff6d6" />
          <circle cx="58" cy="18" r="2.6" fill="#fff6d6" />
          <circle cx="32" cy="36" r="3.4" fill="#c0262d" stroke="#5a3d0c" strokeWidth="1" />
        </g>
      );
    case 'G7':
      return (
        <text x="32" y="51" textAnchor="middle" fontFamily="Cinzel, Georgia, serif" fontWeight="700" fontSize="52" fill={fill} stroke="#5a3d0c" strokeWidth="1.4">
          7
        </text>
      );
    case 'DI':
      return (
        <g>
          <path d="M32 56 L6 24 L16 10 L48 10 L58 24 Z" fill="#dff4ff" stroke={fill} strokeWidth="3" strokeLinejoin="round" />
          <path d="M6 24 L58 24 M16 10 L24 24 L32 56 L40 24 L48 10 M24 24 L32 10 L40 24" fill="none" stroke="#8fb7cc" strokeWidth="1.4" />
        </g>
      );
    case 'GB':
      return (
        <g>
          <path d="M8 46 L16 20 L48 20 L56 46 Z" fill={fill} stroke="#5a3d0c" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M16 20 L20 27 L44 27 L48 20" fill="none" stroke="#fff1c2" strokeWidth="1.4" opacity="0.8" />
          <text x="32" y="42" textAnchor="middle" fontFamily="Cinzel, Georgia, serif" fontWeight="700" fontSize="11" fill="#4a3208">
            BAR
          </text>
        </g>
      );
    case 'BE':
      return (
        <g>
          <path d="M32 8 C20 8 16 20 16 30 L16 40 L10 47 L54 47 L48 40 L48 30 C48 20 44 8 32 8 Z" fill={fill} stroke="#5a3d0c" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="32" cy="52" r="5" fill={fill} stroke="#5a3d0c" strokeWidth="1.4" />
          <path d="M23 18 C21 24 21 30 21 36" stroke="#fff1c2" strokeWidth="2" fill="none" opacity="0.7" strokeLinecap="round" />
        </g>
      );
    case 'CH':
      return (
        <g>
          <path d="M33 10 C30 22 24 28 20 34 M33 10 C38 22 42 28 44 36" stroke="#3f8a3a" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          <path d="M33 10 C40 6 48 8 52 12 C46 14 40 14 33 10 Z" fill="#4fa548" />
          <circle cx="20" cy="42" r="11" fill="#d1262f" stroke="#6e0d12" strokeWidth="1.4" />
          <circle cx="44" cy="44" r="11" fill="#d1262f" stroke="#6e0d12" strokeWidth="1.4" />
          <circle cx="16" cy="38" r="3" fill="#ff8a8e" opacity="0.8" />
          <circle cx="40" cy="40" r="3" fill="#ff8a8e" opacity="0.8" />
        </g>
      );
    case 'GD':
      return (
        <g>
          <rect x="3" y="3" width="58" height="58" rx="12" fill={fill} stroke="#5a3d0c" strokeWidth="1.5" />
          <g transform="translate(32 32) scale(0.78) translate(-32 -32)">
            <PairadiceMarkShapes gradId={`${uid}d`} />
          </g>
        </g>
      );
    default:
      return null;
  }
}

export default function VipSymbol({ id, small = false }) {
  const uid = `vs${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const name = id ? VIP_SYMBOLS[id]?.name ?? 'Symbol' : 'Any symbol';
  if (!id) {
    return (
      <span className={small ? 'vsym small any' : 'vsym any'} aria-label={name}>
        any
      </span>
    );
  }
  if (id === 'BL') return <span className={small ? 'vsym small blank' : 'vsym blank'} role="img" aria-label="Blank" />;
  return (
    <span className={small ? `vsym small ${id}` : `vsym ${id}`} role="img" aria-label={name}>
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <defs>
          <Gold id={uid} />
          <linearGradient id={`${uid}d`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f8e3a3" />
            <stop offset="50%" stopColor="#e2bd62" />
            <stop offset="100%" stopColor="#a97b2c" />
          </linearGradient>
        </defs>
        <Shape id={id} g={uid} uid={uid} />
      </svg>
    </span>
  );
}
