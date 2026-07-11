import { Routes, Route, Navigate } from 'react-router-dom';
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

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<PortfolioPage />} />
      <Route path="/transactions" element={<TransactionsPage />} />
      <Route path="/transactions/new" element={<TransactionFormPage />} />
      <Route path="/transactions/:id" element={<TransactionFormPage />} />
      <Route path="/analysis" element={<AnalysisPage />} />
      <Route path="/analysis/stock/:symbol/:market" element={<StockDetailPage />} />
      <Route path="/analysis/ranking" element={<FullRankingPage />} />
      <Route path="/analysis/calendar/:mode/:date" element={<ProfitCalendarDetailPage />} />
      <Route path="/data" element={<DataPage />} />
      <Route path="/data/backup" element={<ImportExportPage />} />
      <Route path="/data/imports" element={<ImportExportPage />} />
      <Route path="/data/cache" element={<MarketCachePage />} />
      <Route path="/import-export" element={<Navigate to="/data/backup" replace />} />
      <Route path="/market-cache" element={<Navigate to="/data/cache" replace />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
