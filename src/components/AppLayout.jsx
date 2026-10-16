import { Outlet, useLocation } from 'react-router-dom';
import NavBar from './NavBar.jsx';
import BetSlip from './BetSlip.jsx';
import { BetSlipProvider } from '../context/BetSlipContext.jsx';

export default function AppLayout() {
  const location = useLocation();
  const onSportsbook = location.pathname.startsWith('/sportsbook');

  return (
    <BetSlipProvider>
      <div className={onSportsbook ? 'app-shell has-slip' : 'app-shell'}>
        <NavBar />
        <main className="app-main">
          <Outlet />
        </main>
        {onSportsbook ? <BetSlip /> : null}
      </div>
    </BetSlipProvider>
  );
}
