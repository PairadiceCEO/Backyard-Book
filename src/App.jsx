import { Navigate, Route, Routes } from 'react-router-dom';
import { missingFirebaseConfig } from './firebase.js';
import FullPageMessage from './components/FullPageMessage.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import RequireAdmin from './components/RequireAdmin.jsx';
import AppLayout from './components/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import SportsbookPage from './pages/SportsbookPage.jsx';
import MyBetsPage from './pages/MyBetsPage.jsx';
import LeaderboardPage from './pages/LeaderboardPage.jsx';
import ShopPage from './pages/ShopPage.jsx';
import AdminPage from './pages/admin/AdminPage.jsx';

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
