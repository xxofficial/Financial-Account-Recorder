import { useRef } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import PortfolioPage from '../pages/PortfolioPage';
import TransactionsPage from '../pages/TransactionsPage';
import TransactionFormPage from '../pages/TransactionFormPage';
import AnalysisPage from '../pages/AnalysisPage';
import ImportExportPage from '../pages/ImportExportPage';
import SettingsPage from '../pages/SettingsPage';
import StockDetailPage from '../pages/StockDetailPage';
import FullRankingPage from '../pages/FullRankingPage';
import ProfitCalendarDetailPage from '../pages/ProfitCalendarDetailPage';
import MarketCachePage from '../pages/MarketCachePage';
import DataPage from '../pages/DataPage';
import ExpiredOptionsPage from '../pages/ExpiredOptionsPage';

export default function AppRoutes() {
  const { pathname } = useLocation();
  const topLevelPath = pathname === '/' || pathname === '/analysis' || pathname === '/data' || pathname === '/transactions';
  const visitedPrimaryPages = useRef(new Set<string>(topLevelPath ? [pathname] : ['/']));
  if (topLevelPath) visitedPrimaryPages.current.add(pathname);
  return <>
    <PrimaryPages activePath={topLevelPath ? pathname : null} visitedPaths={visitedPrimaryPages.current} />
    {!topLevelPath && <Routes>
      <Route path="/transactions/new" element={<TransactionFormPage />} />
      <Route path="/transactions/:id" element={<TransactionFormPage />} />
      <Route path="/analysis/stock/:symbol/:market" element={<StockDetailPage />} />
      <Route path="/analysis/ranking" element={<FullRankingPage />} />
      <Route path="/analysis/calendar/:mode/:date" element={<ProfitCalendarDetailPage />} />
      <Route path="/data/backup" element={<ImportExportPage />} />
      <Route path="/data/imports" element={<ImportExportPage />} />
      <Route path="/data/email-imports" element={<ImportExportPage />} />
      <Route path="/data/cache" element={<MarketCachePage />} />
      <Route path="/data/corporate-actions" element={<ExpiredOptionsPage />} />
      <Route path="/import-export" element={<Navigate to="/data/backup" replace />} />
      <Route path="/market-cache" element={<Navigate to="/data/cache" replace />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>}
  </>;
}

/**
 * Keep the four bottom-tab pages mounted while navigating between them.  This
 * preserves Dexie subscriptions, calculated portfolio state and the shared
 * analysis worker result instead of rebuilding each page on every tab switch.
 */
function PrimaryPages({ activePath, visitedPaths }: { activePath: string | null; visitedPaths: Set<string> }) {
  return <>
    {visitedPaths.has('/') && <div hidden={activePath !== '/'} aria-hidden={activePath !== '/'}><PortfolioPage /></div>}
    {visitedPaths.has('/analysis') && <div hidden={activePath !== '/analysis'} aria-hidden={activePath !== '/analysis'}><AnalysisPage /></div>}
    {visitedPaths.has('/data') && <div hidden={activePath !== '/data'} aria-hidden={activePath !== '/data'}><DataPage /></div>}
    {visitedPaths.has('/transactions') && <div hidden={activePath !== '/transactions'} aria-hidden={activePath !== '/transactions'}><TransactionsPage /></div>}
  </>;
}
