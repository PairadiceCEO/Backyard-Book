// The Pairadice house chip's colour table and ring text (0.26.0), from the approved mockup. Plain JS so the tests can read it.

// base / highlight / inserts / ring text, per denomination in dollars.
export const HOUSE_CHIP_COLORS = {
  1: { base: '#e9e5da', hi: '#ffffff', ins: '#2b5fc9', ring: '#6b4e14' },
  2: { base: '#e9b928', hi: '#f6d35c', ins: '#ffffff', ring: '#3a2a0c' },
  5: { base: '#a51d25', hi: '#d43a41', ins: '#f4efe2', ring: '#f8e3a3' },
  10: { base: '#1a4fb5', hi: '#3a72d8', ins: '#f4efe2', ring: '#f8e3a3' },
  25: { base: '#156b37', hi: '#24994f', ins: '#f4efe2', ring: '#f8e3a3' },
  100: { base: '#0b0b0d', hi: '#2c2c31', ins: '#d8b45a', ring: '#f1d283' },
  1000: { base: '#c26f10', hi: '#ee9a2e', ins: '#141416', ring: '#1d1404' },
  10000: { base: '#4f1f80', hi: '#7a3fb6', ins: '#d8b45a', ring: '#f8e3a3' },
};

// "$1", "$25", "$1,000", "$10,000": the value printed on the ring.
export function chipRingValue(dollars) {
  return `$${Number(dollars).toLocaleString('en-US')}`;
}
