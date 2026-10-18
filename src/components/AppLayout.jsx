import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import NavBar from './NavBar.jsx';
import BetSlip from './BetSlip.jsx';
import { ErrorBoundary, OfflineBanner } from './StatusViews.jsx';
import { BattlesProvider } from '../context/BattlesContext.jsx';
import { BetSlipProvider } from '../context/BetSlipContext.jsx';
import { WalletDisplayProvider } from '../context/WalletDisplayContext.jsx';
import { requestSettlement } from '../lib/settle.js';

export default function AppLayout() {
  const location = useLocation();
  // The bet slip belongs to the boards and game pages, not the Battle pages.
  const onSportsbook = location.pathname.startsWith('/sportsbook') && !location.pathname.startsWith('/sportsbook/battles');

  // App open: settle any finished games once. Empty deps → runs once per sign-in; sets no state.
  useEffect(() => {
    requestSettlement();
  }, []);

  return (
    <BetSlipProvider>
      <BattlesProvider>
      <WalletDisplayProvider>
        <div className={onSportsbook ? 'app-shell has-slip' : 'app-shell'}>
          <NavBar />
          <OfflineBanner />
          <main className="app-main">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
          {onSportsbook ? <BetSlip /> : null}
        </div>
      </WalletDisplayProvider>
      </BattlesProvider>
    </BetSlipProvider>
  );
}
