/**
 * Turning `/api/analytics/factors` into rows a tired person can read without
 * being misled.
 *
 * This module is where most of the statistical honesty of the product lives,
 * so the rules it enforces are worth spelling out:
 *
 *  1. **No bare point estimates.** Every row's headline carries the interval.
 *     A difference without its uncertainty is a claim, not a measurement.
 *  2. **The interval decides the emphasis, not the p-value.** A row whose CI
 *     crosses zero is drawn grey and says so in words. Only rows the API
 *     itself marks significant are allowed colour.
 *  3. **Tiers, not verdicts.** "Exploratory / Suggestive / Notable pattern".
 *     The word "significant" never reaches the screen, and a p-value is never
 *     a headline.
 *  4. **No causal verbs.** Every phrase this module can emit is a constant in
 *     {@link PHRASES} or a metric's own wording, and both are scanned at
 *     startup in dev by {@link findCausalLanguage}. Tag labels come from the
 *     user and are interpolated, never rewritten.
 */

import { formatCountOf, plural, titleCase } from '../../lib/format';
import type {
  Confounder,
  FactorResult,
  FactorsResponse,
  InsufficientFactor,
} from '../../lib/types';
import { METRIC_SPECS, MIDPOINT_SPEC } from './metrics';
import type { MetricSpec } from './metrics';

// ---------------------------------------------------------------------------
// Evidence tiers
// ---------------------------------------------------------------------------

export type EvidenceTier = 'exploratory' | 'suggestive' | 'notable';

export const TIER_RANK: Record<EvidenceTier, number> = {
  exploratory: 0,
  suggestive: 1,
  notable: 2,
};

export const TIER_LABEL: Record<EvidenceTier, string> = {
  exploratory: 'Exploratory',
  suggestive: 'Suggestive',
  notable: 'Notable pattern',
};

/**
 * A three-rung ladder drawn with filled and hollow blocks, so the tier is
 * legible in greyscale and to a screen reader that reads the label beside it.
 */
export const TIER_GLYPH: Record<EvidenceTier, string> = {
  exploratory: '▮▯▯',
  suggestive: '▮▮▯',
  notable: '▮▮▮',
};

export const TIER_BLURB: Record<EvidenceTier, string> = {
  exploratory: 'Nights with and without this tag look much the same so far.',
  suggestive: 'A gap worth watching. It could still be chance.',
  notable: 'The gap holds up after accounting for how many tags were compared.',
};

// ---------------------------------------------------------------------------
// The vocabulary. Everything this module can say is here.
// ---------------------------------------------------------------------------

export const PHRASES = {
  /** The fixed note above the list. Never collapsed, never dismissible. */
  association:
    'This shows what tended to happen on nights that carried a tag, next to nights that did not. ' +
    'Nights with a tag differ in plenty of other ways too, so a gap here is a pattern to look at, not a reason for it.',
  chance: 'The interval includes zero, so this could easily be chance.',
  noInterval: 'No interval came back for this one, so treat it as a hint only.',
  sameAsWithout: 'looked about the same as nights without it',
  averaged: 'averaged',
  thanWithout: 'than nights without it',
  wentWith: 'went with',
  moreOf: 'More of this',
  overNights: 'across',
  confounded: 'Shares nights with another tag',
  concentrated: 'Bunched into one stretch of the record',
  concentratedWhy:
    'Almost all of these nights sit close together, so a change over the same weeks — a growth spurt, a house move, a new room — would look identical.',
  confoundedWhy:
    'These two tags are applied on nearly the same nights, so the numbers cannot tell them apart.',
  emptyTitle: 'Nothing stands out yet',
  emptyBody:
    'No tag separated itself from the others over this window. That is the ordinary result, and it is a fine one: it means nothing in the routine is showing up as an obvious pattern. Keep tagging and look again in a few weeks.',
  quietTitle: 'Nothing rises above exploratory yet',
  quietBody:
    'Everything compared is listed below, ordered by the size of the gap. None of it has separated from chance yet.',
} as const;

/**
 * Verbs and connectives that assert a mechanism. A sentence on this page may
 * never contain one, because nothing on this page can support one.
 *
 * Only *generated* text is checked, and only at startup: a tag the user named
 * "Late nap because of daycare" is their words, and rewriting a person's own
 * label would be worse than the risk of the word appearing.
 */
const CAUSAL_PATTERN =
  /\b(caus(?:e|es|ed|ing)|because|due to|thanks to|lead(?:s|ing)? to|led to|result(?:s|ed|ing)? in|make(?:s)? .{0,20}(?:worse|better)|improv(?:e|es|ed|ing)|worsen(?:s|ed|ing)?|help(?:s|ed|ing)?|hurt(?:s|ing)?|harm(?:s|ed|ing)?|prevent(?:s|ed|ing)?|trigger(?:s|ed|ing)?|fix(?:es|ed|ing)?|stops? .{0,20}from|blame|responsible for|effect of|impact(?:s|ed)? on|drive(?:s|n)?)\b/i;

/** The offending phrase, or null when the text is clean. */
export function findCausalLanguage(text: string): string | null {
  const match = CAUSAL_PATTERN.exec(text);
  return match ? match[0] : null;
}

/**
 * Scan a batch of generated strings. Returns the offenders rather than
 * throwing, so a caller can decide whether to warn or fail.
 */
export function auditPhrases(strings: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const text of strings) {
    const hit = findCausalLanguage(text);
    if (hit) offenders.push(`"${hit}" in: ${text}`);
  }
  return offenders;
}

if (import.meta.env.DEV) {
  const generated = [
    ...Object.values(PHRASES),
    ...Object.values(TIER_BLURB),
    ...Object.values(TIER_LABEL),
    ...[...METRIC_SPECS, MIDPOINT_SPEC].flatMap((spec) => [
      spec.phrase('down'),
      spec.phrase('up'),
      spec.gap(1, 'down'),
      spec.gap(1, 'up'),
      spec.noun,
    ]),
  ];
  const offenders = auditPhrases(generated);
  if (offenders.length > 0) {
    console.error('[analytics] causal language in a generated phrase:\n' + offenders.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type FlagKind = 'confounded' | 'concentrated';

export interface FactorFlag {
  kind: FlagKind;
  /** Chip text. Short. */
  label: string;
  /** The long form, shown in the disclosure. */
  detail: string;
}

export interface FactorRow {
  key: string;
  label: string;
  /** A two-group comparison (a bool tag) or a rank correlation (a valued tag). */
  kind: 'group' | 'correlation';
  /** The point estimate, in the metric's own units (or ρ for a correlation). */
  point: number | null;
  ci: readonly [number, number] | null;
  hasInterval: boolean;
  /** True when the interval spans zero, or when there is no interval at all. */
  crossesZero: boolean;
  /** Only rows the API marks significant, whose CI also excludes zero. */
  coloured: boolean;
  /** Whether the point sits on the better or worse side for this metric. */
  tone: 'good' | 'bad' | 'neutral';
  tier: EvidenceTier;
  /** Magnitude of the shrunken effect size the API returned. Sort key. */
  effect: number;
  nWith: number | null;
  nWithout: number | null;
  /** Nights the marker's area is scaled by. */
  markerN: number;
  qValue: number | null;
  /** "−18 min (95% CI −41 to +5 min)" */
  headline: string;
  /** The same fact as a sentence. */
  sentence: string;
  /** Present exactly when the interval does not exclude zero. */
  caution: string | null;
  flags: FactorFlag[];
  /** Anything else the API wanted to say, verbatim. */
  caveats: string[];
}

/**
 * Optional fields the contract does not promise. Read defensively: if the
 * service grows a real "this tag is bunched up" flag we use it, and until then
 * we fall back to reading the caveat strings.
 */
interface FactorExtras {
  /** Fraction of the window the tag's nights span, 0..1. */
  span_fraction?: number | null;
  concentrated?: boolean | null;
  /** Some services send the sort key separately. */
  effect_shrunk?: number | null;
}

const CONCENTRATION_HINT =
  /\b(stretch|span(?:s|ned)?|consecutive|clustered|cluster|bunched|narrow|one period|single period|same period|same week|same month)\b/i;

function crossesZero(ci: readonly [number, number] | null): boolean {
  if (!ci) return true;
  const [low, high] = ci;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return true;
  return low <= 0 && high >= 0;
}

function finite(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

function pair(value: readonly [number, number] | null | undefined): [number, number] | null {
  if (!value) return null;
  const [low, high] = value;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return low <= high ? [low, high] : [high, low];
}

/** "95% CI −41 to +5 min", or null when there is no interval. */
function intervalText(ci: readonly [number, number] | null, spec: MetricSpec): string | null {
  if (!ci) return null;
  const suffix = spec.unit ? ` ${spec.unit}` : '';
  return `95% CI ${spec.formatBound(ci[0])} to ${spec.formatBound(ci[1])}${suffix}`;
}

/** "95% CI −0.55 to −0.09" for a correlation, which has no unit. */
function rhoIntervalText(ci: readonly [number, number] | null): string | null {
  if (!ci) return null;
  return `95% CI ${formatRho(ci[0])} to ${formatRho(ci[1])}`;
}

export function formatRho(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Number(value.toFixed(2));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(2)}`;
}

function toneFor(point: number | null, spec: MetricSpec): 'good' | 'bad' | 'neutral' {
  if (point === null || point === 0) return 'neutral';
  const up = point > 0;
  return up === (spec.better === 'higher') ? 'good' : 'bad';
}

function tierFor(factor: FactorResult, spansZero: boolean, hasInterval: boolean): EvidenceTier {
  if (factor.significant && hasInterval && !spansZero) return 'notable';
  if (hasInterval && !spansZero) return 'suggestive';
  const q = finite(factor.q_value);
  if (q !== null && q <= 0.25) return 'suggestive';
  const p = finite(factor.p_value);
  if (p !== null && p <= 0.05) return 'suggestive';
  return 'exploratory';
}

function flagsFor(factor: FactorResult, extras: FactorExtras, spanThreshold: number): FactorFlag[] {
  const flags: FactorFlag[] = [];

  const confounders: Confounder[] = factor.confounders ?? [];
  if (confounders.length > 0) {
    const names = confounders.map((entry) => entry.label ?? entry.slug);
    flags.push({
      kind: 'confounded',
      label: `${PHRASES.confounded}: ${names.join(', ')}`,
      detail: PHRASES.confoundedWhy,
    });
  }

  const caveats = factor.caveats ?? [];
  const spanFraction = finite(extras.span_fraction);
  const concentrated =
    extras.concentrated === true ||
    (spanFraction !== null && spanFraction < spanThreshold) ||
    caveats.some((caveat) => CONCENTRATION_HINT.test(caveat));

  if (concentrated) {
    flags.push({
      kind: 'concentrated',
      label: PHRASES.concentrated,
      detail: PHRASES.concentratedWhy,
    });
  }

  return flags;
}

/** Caveats already surfaced as a flag should not be repeated underneath. */
function residualCaveats(factor: FactorResult, flags: readonly FactorFlag[]): string[] {
  const caveats = factor.caveats ?? [];
  const hasConfounded = flags.some((flag) => flag.kind === 'confounded');
  const hasConcentrated = flags.some((flag) => flag.kind === 'concentrated');
  return caveats.filter((caveat) => {
    if (hasConcentrated && CONCENTRATION_HINT.test(caveat)) return false;
    if (hasConfounded && /co-?occur|overlap|together with|alongside/i.test(caveat)) return false;
    return true;
  });
}

function groupRow(factor: FactorResult, spec: MetricSpec, extras: FactorExtras, spanThreshold: number): FactorRow {
  const diff = finite(factor.diff ?? null);
  const ci = pair(factor.diff_ci95 ?? null);
  const hasInterval = ci !== null;
  const spansZero = crossesZero(ci);
  const nWith = finite(factor.n_with ?? null);
  const nWithout = finite(factor.n_without ?? null);

  const interval = intervalText(ci, spec);
  const headline =
    diff === null
      ? '—'
      : interval
        ? `${spec.formatDiff(diff)} (${interval})`
        : spec.formatDiff(diff);

  const sentence =
    diff === null || Math.abs(diff) < 1e-9
      ? `Nights with this tag ${PHRASES.sameAsWithout}.`
      : `Nights with this tag ${PHRASES.averaged} ${spec.gap(diff, diff < 0 ? 'down' : 'up')} ${PHRASES.thanWithout}.`;

  const flags = flagsFor(factor, extras, spanThreshold);

  return {
    key: factor.slug,
    label: factor.label || factor.slug,
    kind: 'group',
    point: diff,
    ci,
    hasInterval,
    crossesZero: spansZero,
    coloured: Boolean(factor.significant) && hasInterval && !spansZero,
    tone: toneFor(diff, spec),
    tier: tierFor(factor, spansZero, hasInterval),
    effect: effectMagnitude(factor, extras),
    nWith,
    nWithout,
    markerN: nWith ?? 0,
    qValue: finite(factor.q_value),
    headline,
    sentence,
    caution: hasInterval ? (spansZero ? PHRASES.chance : null) : PHRASES.noInterval,
    flags,
    caveats: residualCaveats(factor, flags),
  };
}

function correlationRow(
  factor: FactorResult,
  spec: MetricSpec,
  extras: FactorExtras,
  spanThreshold: number,
): FactorRow {
  const rho = finite(factor.spearman_rho ?? null);
  const ci = pair(factor.rho_ci95 ?? null);
  const hasInterval = ci !== null;
  const spansZero = crossesZero(ci);
  const n = finite(factor.n ?? null);

  const interval = rhoIntervalText(ci);
  const headline =
    rho === null ? '—' : interval ? `ρ ${formatRho(rho)} (${interval})` : `ρ ${formatRho(rho)}`;

  // A slope that rounds away at the metric's own precision says nothing, so
  // it is left out rather than printed as "±0.0 per minute".
  const slope = finite(factor.slope_per_unit ?? null);
  const slopeLabel = slope === null ? null : spec.formatDiff(slope);
  const slopeText =
    slopeLabel === null || slopeLabel.startsWith('±')
      ? ''
      : ` About ${slopeLabel} per ${factor.unit ?? 'unit'}.`;

  const sentence =
    rho === null || Math.abs(rho) < 1e-9
      ? `More of this tag ${PHRASES.sameAsWithout}.`
      : `${PHRASES.moreOf} ${PHRASES.wentWith} ${spec.phrase(rho < 0 ? 'down' : 'up')}, ` +
        `${PHRASES.overNights} ${formatCountOf(n, 'night')}.${slopeText}`;

  const flags = flagsFor(factor, extras, spanThreshold);

  return {
    key: factor.slug,
    label: factor.label || factor.slug,
    kind: 'correlation',
    point: rho,
    ci,
    hasInterval,
    crossesZero: spansZero,
    coloured: Boolean(factor.significant) && hasInterval && !spansZero,
    tone: toneFor(rho, spec),
    tier: tierFor(factor, spansZero, hasInterval),
    effect: effectMagnitude(factor, extras),
    nWith: n,
    nWithout: null,
    markerN: n ?? 0,
    qValue: finite(factor.q_value),
    headline,
    sentence,
    caution: hasInterval ? (spansZero ? PHRASES.chance : null) : PHRASES.noInterval,
    flags,
    caveats: residualCaveats(factor, flags),
  };
}

/**
 * The sort key: the magnitude of the shrunken effect size the API returned.
 *
 * Shrinkage is the whole point of sorting on it — `analytics.shrinkage` pulls
 * each tag toward zero in proportion to its own noise, which is what stops a
 * tag with eleven nights and a wild sample mean from permanently topping the
 * list. Falling back to the raw difference would undo that, so the fallbacks
 * are other standardised quantities, and finally zero.
 */
function effectMagnitude(factor: FactorResult, extras: FactorExtras): number {
  const shrunk = finite(extras.effect_shrunk ?? null);
  if (shrunk !== null) return Math.abs(shrunk);
  const effect = finite(factor.effect_size?.value ?? null);
  if (effect !== null) return Math.abs(effect);
  const cliffs = finite(factor.cliffs_delta ?? null);
  if (cliffs !== null) return Math.abs(cliffs);
  const rho = finite(factor.spearman_rho ?? null);
  if (rho !== null) return Math.abs(rho);
  return 0;
}

export interface BuiltFactors {
  /** Bool tags: a difference in the metric's own units. */
  groups: FactorRow[];
  /** Valued tags: a rank correlation, which needs its own axis. */
  correlations: FactorRow[];
  /** Everything, for counting. */
  all: FactorRow[];
  /** The best tier present, or null when there is nothing at all. */
  bestTier: EvidenceTier | null;
}

export interface BuildOptions {
  /**
   * `analytics.min_span_fraction`: below this share of the window, a tag's
   * nights are treated as bunched together. Only used when the API has not
   * already said so.
   */
  spanThreshold?: number;
}

/**
 * Build the display rows, ordered by shrunken effect magnitude, largest first.
 *
 * Magnitude rather than signed value: the question this page answers is "what
 * is the biggest apparent gap", and a signed sort would bury a large positive
 * gap at the bottom purely for being positive.
 */
export function buildFactorRows(
  response: FactorsResponse | undefined,
  spec: MetricSpec,
  options: BuildOptions = {},
): BuiltFactors {
  const spanThreshold = options.spanThreshold ?? 0.4;
  const factors = response?.factors ?? [];

  const rows = factors.map((factor) => {
    const extras = factor as FactorResult & FactorExtras;
    const continuous =
      factor.value_type === 'number' ||
      factor.value_type === 'duration' ||
      factor.value_type === 'time';
    return continuous
      ? correlationRow(factor, spec, extras, spanThreshold)
      : groupRow(factor, spec, extras, spanThreshold);
  });

  const order = (a: FactorRow, b: FactorRow): number => {
    if (b.effect !== a.effect) return b.effect - a.effect;
    const aq = a.qValue ?? 1;
    const bq = b.qValue ?? 1;
    if (aq !== bq) return aq - bq;
    return a.label.localeCompare(b.label);
  };

  const groups = rows.filter((row) => row.kind === 'group').sort(order);
  const correlations = rows.filter((row) => row.kind === 'correlation').sort(order);
  const all = [...groups, ...correlations];

  let bestTier: EvidenceTier | null = null;
  for (const row of all) {
    if (bestTier === null || TIER_RANK[row.tier] > TIER_RANK[bestTier]) bestTier = row.tier;
  }

  return { groups, correlations, all, bestTier };
}

// ---------------------------------------------------------------------------
// The axis domain
// ---------------------------------------------------------------------------

/**
 * A domain covering every interval in the set, always symmetric about zero so
 * the zero line sits in the middle and a gap to the left is visibly the mirror
 * of the same gap to the right.
 */
export function forestDomain(rows: readonly FactorRow[]): [number, number] {
  let reach = 0;
  for (const row of rows) {
    if (row.point !== null) reach = Math.max(reach, Math.abs(row.point));
    if (row.ci) reach = Math.max(reach, Math.abs(row.ci[0]), Math.abs(row.ci[1]));
  }
  if (reach === 0 || !Number.isFinite(reach)) reach = 1;
  const padded = reach * 1.08;
  return [-padded, padded];
}

// ---------------------------------------------------------------------------
// The "not enough nights yet" list
// ---------------------------------------------------------------------------

export interface WaitingRow {
  key: string;
  label: string;
  /** Nights the tag has so far. */
  have: number;
  /** Nights it needs. */
  need: number;
  /** "6 more nights with this tag" */
  progressText: string;
  /** 0..1, for the bar. */
  fraction: number;
}

/**
 * A tag below the minimum-n gate gets a progress counter, never a statistic.
 *
 * Showing "n = 3, p = 0.04" for a tag with three nights is the single most
 * misleading thing this page could do: at that size the only detectable
 * effects are enormous ones, and any that clear significance are inflated.
 * So the number is replaced with the distance to the gate.
 */
export function buildWaitingRows(
  insufficient: readonly InsufficientFactor[] | undefined,
  minN: number,
): WaitingRow[] {
  const need = Math.max(1, Math.round(minN));
  return (insufficient ?? [])
    .map((entry) => {
      const have = Math.max(0, Math.round(finite(entry.n_with ?? entry.n ?? 0) ?? 0));
      const remaining = Math.max(0, need - have);
      return {
        key: entry.slug,
        label: entry.label ?? titleCase(entry.slug),
        have,
        need,
        progressText:
          remaining === 0
            ? 'Ready at the next recompute'
            : `${remaining} more ${plural(remaining, 'night')} with this tag`,
        fraction: need === 0 ? 1 : Math.min(1, have / need),
      };
    })
    .sort((a, b) => b.fraction - a.fraction || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// The multiplicity denominator
// ---------------------------------------------------------------------------

/**
 * "We compared 14 tags; adjusted with Benjamini-Hochberg at a 10% false
 * discovery rate."
 *
 * The denominator is the point. Fourteen comparisons at a naive 5% throw off
 * one spurious "finding" more often than not, and a reader who is not told how
 * many were run has no way to discount the one they are looking at.
 */
export function multiplicityNote(
  response: FactorsResponse | undefined,
  /** `analytics.fdr_q`, used only when the response does not state its own. */
  fallbackAlpha?: number | null,
): string | null {
  const compared = response?.factors?.length ?? 0;
  if (compared === 0) return null;

  const subject = `We compared ${compared} ${plural(compared, 'tag')}`;
  const correction = correctionName(response?.method?.correction);
  const alpha = finite(response?.method?.alpha ?? null) ?? finite(fallbackAlpha ?? null);

  if (!correction) return `${subject}.`;
  if (alpha === null) return `${subject}; adjusted with ${correction}.`;

  const rate = Number((alpha * 100).toFixed(alpha * 100 < 1 ? 1 : 0));
  return `${subject}; adjusted with ${correction} at a ${rate}% false discovery rate.`;
}

/**
 * "Some tags were tested with a weaker null." — shown when it happened.
 *
 * The circular-shift null is the reason these results are not riddled with
 * false positives from one night's sleep resembling the next, and it
 * downgrades itself to free shuffling when the record is short or a tag too
 * regular to rotate. A reader told the guardrail was on when it was off would
 * trust exactly the wrong numbers hardest, so the API reports what actually
 * ran and this surfaces it.
 */
export function methodNote(response: FactorsResponse | undefined): string | null {
  const downgraded = response?.method?.downgraded;
  return typeof downgraded === 'string' && downgraded.length > 0 ? downgraded : null;
}

function correctionName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (key === 'benjamini-hochberg' || key === 'bh' || key === 'fdr-bh') return 'Benjamini-Hochberg';
  if (key === 'benjamini-yekutieli' || key === 'by') return 'Benjamini-Yekutieli';
  if (key === 'bonferroni') return 'Bonferroni';
  if (key === 'holm' || key === 'holm-bonferroni') return 'Holm-Bonferroni';
  if (key === 'none') return null;
  return raw;
}

/** "131 of 142 nights could be analysed." */
export function coverageNote(response: FactorsResponse | undefined): string | null {
  if (!response) return null;
  const total = finite(response.nights_total);
  const usable = finite(response.nights_analysable);
  if (total === null || usable === null) return null;
  return `${usable} of ${total} ${plural(total, 'night')} in this window could be analysed.`;
}
