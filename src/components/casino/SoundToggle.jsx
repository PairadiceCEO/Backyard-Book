// The one mute button (0.20.0), in the top bar of every casino page and the lobby. On by default; the choice is saved per
// phone and shared by every game (src/lib/casinoSound.js). Rendering it also registers the page for sound: its first tap
// unlocks the AudioContext.
import { setSoundOn, useCasinoSound, useSoundOn } from '../../lib/casinoSound.js';

export default function SoundToggle({ className = '' }) {
  useCasinoSound();
  const on = useSoundOn();
  return (
    <button
      type="button"
      className={['btn btn-ghost small sound-btn', on ? 'on' : 'off', className].filter(Boolean).join(' ')}
      aria-pressed={on}
      aria-label={on ? 'Sound on. Tap to mute.' : 'Sound off. Tap to turn sound on.'}
      title={on ? 'Sound on' : 'Sound off'}
      onClick={() => setSoundOn(!on)}
    >
      <span aria-hidden="true">{on ? '🔊' : '🔇'}</span>
    </button>
  );
}
