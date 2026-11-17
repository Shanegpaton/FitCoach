import { installDiagnostics } from './diagnostics';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { AuthProvider, getSyncAccessToken } from './auth';
import './styles.css';

installDiagnostics(async event => {
  const apiUrl = import.meta.env.VITE_FITCOACH_API_URL as string | undefined;
  if (!apiUrl) return;
  const token = await getSyncAccessToken();
  if (!token) return;
  await fetch(`${apiUrl}/v1/diagnostics`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event), signal: AbortSignal.timeout(5000) });
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter></ErrorBoundary></React.StrictMode>,
);
