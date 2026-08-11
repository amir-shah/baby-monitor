import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles/tokens.css';
import './styles/base.css';

import { App } from './App';
import { ToastProvider } from './components';
import { ThemeProvider } from './hooks/useTheme';
import { ApiError } from './lib/api';

/**
 * Query defaults tuned for a LAN dashboard fed by SSE.
 *
 * Most screens get their live updates pushed over `/api/stream/events`, so
 * polling is off by default and `staleTime` is generous — a refetch on every
 * window focus would hammer a Pi that is also encoding video. Retries skip
 * anything the server has already answered definitively (401/403/404 and the
 * rest of the 4xx range): retrying those just delays the error the user needs
 * to see.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && !error.isTransient) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    },
    mutations: {
      retry: false,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
