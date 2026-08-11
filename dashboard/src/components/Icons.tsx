/**
 * Inline SVG icons. No icon package: the fifteen glyphs this app needs cost
 * about 3kB written by hand and nothing at all in dependency surface.
 *
 * House rules so they sit together on a line:
 *   - 24x24 viewBox, 1.75 stroke, round caps and joins, no fill.
 *   - `currentColor` only, so an icon inherits from its button.
 *   - Decorative by default (`aria-hidden`); the *button* carries the label.
 *     Pass a `title` to make one meaningful on its own.
 */

import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Pixel size for both dimensions. Default 20. */
  size?: number;
  /** Gives the icon an accessible name; otherwise it is hidden from AT. */
  title?: string;
}

function Icon({ size = 20, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* -- Navigation ----------------------------------------------------------- */

export function LiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12a9 9 0 0 1 9-9" />
      <path d="M7 12a5 5 0 0 1 5-5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M21 12a9 9 0 0 1-9 9" />
      <path d="M17 12a5 5 0 0 1-5 5" />
    </Icon>
  );
}

export function NightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </Icon>
  );
}

export function NotesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h8.2L19 7.3v12.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5Z" />
      <path d="M14.5 3v4.5H19" />
      <path d="M8.5 12.5h7M8.5 16h4.5" />
    </Icon>
  );
}

export function AnalyticsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M7.5 16.5V12M12 16.5V7.5M16.5 16.5v-6" />
    </Icon>
  );
}

export function EventsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
      <path d="M10.3 19a2 2 0 0 0 3.4 0" />
    </Icon>
  );
}

export function SystemIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.05Z" />
    </Icon>
  );
}

/* -- Theme ---------------------------------------------------------------- */

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 14.8A8.6 8.6 0 0 1 9.2 3.5a8.6 8.6 0 1 0 11.3 11.3Z" />
    </Icon>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </Icon>
  );
}

export function AutoThemeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/* -- Controls ------------------------------------------------------------- */

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14.5 6-6 6 6 6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 11.5A8 8 0 0 0 6.2 6.6L4 9" />
      <path d="M4 4v5h5" />
      <path d="M4 12.5a8 8 0 0 0 13.8 4.9L20 15" />
      <path d="M20 20v-5h-5" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

/* -- Status --------------------------------------------------------------- */

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 2.8 20h18.4Z" />
      <path d="M12 10v4.2" />
      <circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function OfflineIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3.5 21 21" />
      <path d="M5 12.6a10 10 0 0 1 3.4-2.2M15.7 10.6a10 10 0 0 1 3.3 2" />
      <path d="M8.6 16.1a5.5 5.5 0 0 1 6.9 0" />
      <circle cx="12" cy="19.4" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/* -- Sensors -------------------------------------------------------------- */

export function SoundIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11 5 6.5 8.8H3.5v6.4h3L11 19Z" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6" />
      <path d="M17.8 6.4a8 8 0 0 1 0 11.2" />
    </Icon>
  );
}

export function MotionIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12.5" cy="5" r="1.8" />
      <path d="m9 21 2.2-5.6-2.7-2.4.9-4.4 3.6 2 2.5 1.6" />
      <path d="m11.2 15.4 3.6 1.3 1.4 4.3" />
      <path d="M4.5 10.6 8 8.6" />
    </Icon>
  );
}

export function TemperatureIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 14.3V5.5a2 2 0 1 0-4 0v8.8a4 4 0 1 0 4 0Z" />
      <path d="M12 8.5v6.2" />
    </Icon>
  );
}

export function HumidityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5c3.4 4 6 6.9 6 9.9a6 6 0 0 1-12 0c0-3 2.6-5.9 6-9.9Z" />
    </Icon>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
      <circle cx="12" cy="12.5" r="3.4" />
      <path d="M8 6l1.2-2h5.6L16 6" />
    </Icon>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11.2V4.8A.8.8 0 0 1 4.8 4h6.4a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.2 5.2a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 4 11.2Z" />
      <circle cx="8.3" cy="8.3" r="1.3" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.2 2" />
    </Icon>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h8" />
      <path d="M17 15.5 20.5 12 17 8.5" />
      <path d="M20 12h-9.5" />
    </Icon>
  );
}

/* -- Media and viewport ---------------------------------------------------- */

/** Filled triangle: a play affordance reads better solid than outlined. */
export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5.4v13.2l10.5-6.6Z" fill="currentColor" stroke="currentColor" strokeWidth={1.5} />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 5v14M15 5v14" strokeWidth={2.25} />
    </Icon>
  );
}

/** Arrows pushing outwards — enter full screen. */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4H4v5M20 9V4h-5M15 20h5v-5M4 15v5h5" />
    </Icon>
  );
}

/** Arrows pulling inwards — leave full screen. */
export function CollapseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4" />
    </Icon>
  );
}
