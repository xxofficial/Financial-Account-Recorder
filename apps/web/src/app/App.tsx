import { HashRouter } from 'react-router-dom';
import AppShell from './AppShell';
import AppRoutes from './routes';

export default function App() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppShell>
        <AppRoutes />
      </AppShell>
    </HashRouter>
  );
}
