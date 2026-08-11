import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { nightOf } from '../lib/format';
import {
  AnalyticsIcon,
  EventsIcon,
  LiveIcon,
  NightIcon,
  NotesIcon,
  SystemIcon,
} from './Icons';
import { ThemeToggle } from './ThemeToggle';
import './AppShell.css';

export interface NavItem {
  to: string;
  label: string;
  /** Shorter label for the mobile bar, where six items must fit at 390px. */
  short?: string;
  icon: ReactNode;
  /** Match only the exact path (the index route). */
  end?: boolean;
}

/**
 * The nav is built per render so the Night link points at the current
 * `night_of` rather than a date baked in when the module loaded — a tab left
 * open overnight would otherwise still link to yesterday.
 */
export function buildNavItems(options: { timezone?: string | null; boundaryHour?: number } = {}): NavItem[] {
  const tonight = nightOf(Date.now(), {
    tz: options.timezone,
    boundaryHour: options.boundaryHour,
  });
  return [
    { to: '/', label: 'Live', icon: <LiveIcon />, end: true },
    { to: `/night/${tonight}`, label: 'Night', icon: <NightIcon /> },
    { to: '/notes', label: 'Notes', icon: <NotesIcon /> },
    { to: '/analytics', label: 'Analytics', short: 'Trends', icon: <AnalyticsIcon /> },
    { to: '/events', label: 'Events', icon: <EventsIcon /> },
    { to: '/system', label: 'System', icon: <SystemIcon /> },
  ];
}

export interface AppShellProps {
  children: ReactNode;
  /** Site name from `GET /api/config`. Defaults to the product name. */
  siteName?: string;
  /** Page title in the header. */
  title?: ReactNode;
  /** Header controls: the child picker, a connection badge. */
  headerRight?: ReactNode;
  /** A full-width strip under the header, e.g. a "connection lost" banner. */
  banner?: ReactNode;
  navItems?: NavItem[];
  /** Timezone used to resolve the Night link. */
  timezone?: string | null;
  boundaryHour?: number;
}

/**
 * The app frame: a header, a nav that is a bottom bar on a phone and a side
 * rail from 60rem up, and the routed page.
 *
 * The bottom bar is not a stylistic choice — the phone case is one-handed, in
 * the dark, often while holding a baby, so the primary navigation has to be
 * within thumb reach.
 */
export function AppShell({
  children,
  siteName = 'babymon',
  title,
  headerRight,
  banner,
  navItems,
  timezone,
  boundaryHour,
}: AppShellProps) {
  const items = navItems ?? buildNavItems({ timezone, boundaryHour });

  return (
    <div className="shell">
      <a className="skip-link visually-hidden-focusable" href="#main">
        Skip to content
      </a>

      <header className="shell__header">
        <div className="shell__header-inner">
          <div className="shell__brand">
            <span className="shell__site">{siteName}</span>
            {title ? <h1 className="shell__title">{title}</h1> : null}
          </div>
          <div className="shell__header-right">
            {headerRight}
            <ThemeToggle />
          </div>
        </div>
        {banner ? <div className="shell__banner">{banner}</div> : null}
      </header>

      <nav className="shell__nav" aria-label="Primary">
        <ul className="shell__nav-list">
          {items.map((item) => (
            <li key={item.to} className="shell__nav-item">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive ? 'shell__nav-link is-active' : 'shell__nav-link'
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="shell__nav-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="shell__nav-label">{item.short ?? item.label}</span>
                    {/* The active item is marked by weight and a rule as well
                        as colour; this makes it explicit to assistive tech. */}
                    {isActive ? <span className="visually-hidden"> (current page)</span> : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main className="shell__main" id="main" tabIndex={-1}>
        <div className="shell__content">{children}</div>
      </main>
    </div>
  );
}
