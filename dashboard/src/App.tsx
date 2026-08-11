import { useEffect } from 'react';
import {
  Outlet,
  RouterProvider,
  createBrowserRouter,
  isRouteErrorResponse,
  useLocation,
  useMatches,
  useNavigate,
  useRouteError,
} from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { AppShell, Button, Card, EmptyState, ErrorState } from './components';
import { setUnauthorizedHandler } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import {
  AnalyticsPage,
  EventsPage,
  LivePage,
  NightPage,
  NotesPage,
  SystemPage,
} from './pages/stubs';

/** Route metadata read back by the shell for the header title. */
interface RouteHandle {
  title?: string;
}

function useRouteTitle(): string | undefined {
  const matches = useMatches();
  // The deepest match with a title wins.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]?.handle as RouteHandle | undefined;
    if (handle?.title) return handle.title;
  }
  return undefined;
}

/**
 * The authenticated frame.
 *
 * A 401 from anywhere in the app — including a background refetch — bounces
 * here to /login with the current location in `?next=`, so the user lands back
 * where they were once the session is renewed.
 */
function RootLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const title = useRouteTitle();

  useEffect(() => {
    return setUnauthorizedHandler(() => {
      const next = `${location.pathname}${location.search}`;
      navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    });
  }, [navigate, location.pathname, location.search]);

  return (
    <AppShell title={title}>
      <Outlet />
    </AppShell>
  );
}

/** Rendered when a route throws, including a 404 from the catch-all. */
function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFound />;
  }

  return (
    <div className="shell__content">
      <Card>
        <ErrorState error={error} onRetry={() => navigate(0)} retryLabel="Reload" />
      </Card>
    </div>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState
        title="No such page"
        description="That address does not match anything in the dashboard."
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            Go to Live
          </Button>
        }
      />
    </Card>
  );
}

/**
 * The route table, exported separately from the browser router so tests can
 * mount the same tree under a memory router.
 */
export const routes: RouteObject[] = [
  {
    path: '/login',
    element: <LoginPage />,
    errorElement: <RouteErrorBoundary />,
  },
  {
    element: <RootLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <LivePage />, handle: { title: 'Live' } satisfies RouteHandle },
      {
        path: 'night/:date',
        element: <NightPage />,
        handle: { title: 'Night' } satisfies RouteHandle,
      },
      { path: 'notes', element: <NotesPage />, handle: { title: 'Notes' } satisfies RouteHandle },
      {
        path: 'analytics',
        element: <AnalyticsPage />,
        handle: { title: 'Analytics' } satisfies RouteHandle,
      },
      { path: 'events', element: <EventsPage />, handle: { title: 'Events' } satisfies RouteHandle },
      { path: 'system', element: <SystemPage />, handle: { title: 'System' } satisfies RouteHandle },
      { path: '*', element: <NotFound />, handle: { title: 'Not found' } satisfies RouteHandle },
    ],
  },
];

/**
 * Created on first use rather than at import time: `createBrowserRouter`
 * touches `document`, which would make this module unimportable anywhere
 * without a DOM (a smoke test, a future prerender step).
 */
let browserRouter: ReturnType<typeof createBrowserRouter> | null = null;

export function getRouter() {
  browserRouter ??= createBrowserRouter(routes);
  return browserRouter;
}

export function App() {
  return <RouterProvider router={getRouter()} />;
}

export default App;
