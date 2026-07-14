import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import './index.css';

if (import.meta.env.MODE === 'market-probe' || import.meta.env.VITE_MARKET_PROBE === 'true') {
  import('./marketProbe').then(({ installStockSdkPwaProbe }) => installStockSdkPwaProbe());
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
