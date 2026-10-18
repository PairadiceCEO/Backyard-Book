import { Navigate, Route, Routes } from 'react-router-dom';
import { missingFirebaseConfig } from './firebase.js';
import FullPageMessage from './components/FullPageMessage.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import RequireAdmin from './components/RequireAdmin.jsx';
import AppLayout from './components/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import SportsbookPage from './pages/SportsbookPage.jsx';
import GameDetailPage from './pages/GameDetailPage.jsx';
import NewBattlePage from './pages/battles/NewBattlePage.jsx';
import BattleDetailPage from './pages/battles/BattleDetailPage.jsx';
import NewChallengePage from './pages/challenges/NewChallengePage.jsx';
import ChallengeDetailPage from './pages/challenges/ChallengeDetailPage.jsx';
import MyBetsPage from './pages/MyBetsPage.jsx';
import LeaderboardPage from './pages/LeaderboardPage.jsx';
import ShopPage from './pages/ShopPage.jsx';
import AdminPage from './pages/admin/AdminPage.jsx';
import CasinoLobby from './pages/casino/CasinoLobby.jsx';
import SlotsPage from './pages/casino/SlotsPage.jsx';
import CasinoTablePage from './pages/casino/CasinoTablePage.jsx';

export default function App() {
  if (missingFirebaseConfig.length > 0) {
    return (
      <FullPageMessage title="Firebase is not configured">
        Add these Vercel environment variables, then redeploy: {missingFirebaseConfig.join(', ')}.
      </FullPageMessage>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/sportsbook" element={<SportsbookPage />} />
        <Route path="/sportsbook/battles/new" element={<NewBattlePage />} />
        <Route path="/sportsbook/battles/:battleId" element={<BattleDetailPage />} />
        <Route path="/sportsbook/challenges/new" element={<NewChallengePage />} />
        <Route path="/sportsbook/challenges/:challengeId" element={<ChallengeDetailPage />} />
        <Route path="/sportsbook/:league/:gameId" element={<GameDetailPage />} />
        <Route path="/casino" element={<CasinoLobby />} />
        <Route path="/casino/slots" element={<SlotsPage />} />
        <Route path="/casino/:game" element={<CasinoTablePage />} />
        <Route path="/my-bets" element={<MyBetsPage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="/" element={<Navigate to="/sportsbook" replace />} />
      <Route path="*" element={<Navigate to="/sportsbook" replace />} />
    </Routes>
  );
}
