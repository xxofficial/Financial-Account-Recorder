import { HashRouter } from 'react-router-dom';
import AppShell from './AppShell';
import AppRoutes from './routes';

export default function App() {
  return (
    <HashRouter>
      <AppShell>
        <AppRoutes />
      </AppShell>
    </HashRouter>
  );
}
