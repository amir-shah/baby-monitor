/**
 * Maps the vocabularies onto the semantic CSS classes defined in tokens.css.
 *
 * Adding `state-asleep` to an element sets `--state-color`, `--state-soft`,
 * `--state-on-soft` and `--state-dash` on it, so a component can style itself
 * against those four variables and never needs to know the state names.
 */

import type { Severity, SleepState } from './types';

/** `"state-asleep"`, `"state-unknown"`, … */
export function sleepStateClass(state: SleepState | null | undefined): string {
  return `state-${state ?? 'unknown'}`;
}

/** `"severity-notice"`, … */
export function severityClass(severity: Severity | null | undefined): string {
  return `severity-${severity ?? 'info'}`;
}

/**
 * The stroke-dash pattern for a state, for SVG that cannot inherit a custom
 * property through an attribute (Safari will not resolve `var()` inside
 * `stroke-dasharray` as a presentation attribute).
 */
const STATE_DASH: Record<SleepState, string | undefined> = {
  asleep: undefined,
  restless: '6 3',
  settling: '2 3',
  awake: '10 4',
  absent: '1 4',
  unknown: '3 3 1 3',
};

export function sleepStateDash(state: SleepState | null | undefined): string | undefined {
  return STATE_DASH[state ?? 'unknown'];
}

/**
 * A second, non-colour channel for chart fills: an SVG pattern id per state.
 * Charts render `<StatePatternDefs />` once and reference `url(#pat-asleep)`.
 */
export function sleepStatePatternId(state: SleepState | null | undefined): string {
  return `babymon-pat-${state ?? 'unknown'}`;
}

/** Ordered darkest-sleep-first, which is how a hypnogram legend should read. */
export const SLEEP_STATE_ORDER: readonly SleepState[] = [
  'asleep',
  'restless',
  'settling',
  'awake',
  'absent',
  'unknown',
];
