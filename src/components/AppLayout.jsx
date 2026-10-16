import { Outlet } from 'react-router-dom';
import NavBar from './NavBar.jsx';

export default function AppLayout() {
  return (
    <div className="app-shell">
      <NavBar />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
