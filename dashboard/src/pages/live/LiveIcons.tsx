/**
 * The four glyphs the Live page needs that the shared kit does not have.
 *
 * Kept here rather than added to components/Icons.tsx so this page owns them
 * outright — same house rules though: 24x24, 1.75 stroke, currentColor,
 * decorative unless given a title.
 */

import type { ReactNode, SVGProps } from 'react';

export interface LiveIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  title?: string;
}

function Glyph({
  size = 20,
  title,
  children,
  ...rest
}: LiveIconProps & { children: ReactNode }) {
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

/** Filled triangle: a play affordance reads better solid than outlined. */
export function PlayIcon(props: LiveIconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 5.4v13.2l10.5-6.6Z" fill="currentColor" stroke="currentColor" strokeWidth={1.5} />
    </Glyph>
  );
}

export function PauseIcon(props: LiveIconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 5v14M15 5v14" strokeWidth={2.25} />
    </Glyph>
  );
}

/** Arrows pushing outwards — enter full screen. */
export function ExpandIcon(props: LiveIconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 4H4v5M20 9V4h-5M15 20h5v-5M4 15v5h5" />
    </Glyph>
  );
}

/** Arrows pulling inwards — leave full screen. */
export function CollapseIcon(props: LiveIconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4" />
    </Glyph>
  );
}
