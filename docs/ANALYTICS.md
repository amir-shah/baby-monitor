# Analytics

Every number babymon shows you, where it comes from, and — the last section,
which is the important one — what it cannot tell you.

Everything here is documented from the code that actually runs it:
`pi/babymon/sleep/metrics.py` for the metrics and the score,
`pi/babymon/analytics/stats.py` for the statistics, and
`pi/babymon/analytics/correlate.py` for the factor analysis. Where the code and
this document disagree, the code is right and this is a bug.

**None of it is a medical measurement.** A camera and a microphone infer sleep
from stillness and quiet. That is what actigraphy does, it is a genuinely
useful signal, and it is not polysomnography.

---

## Part 1 — Night metrics

### The four anchors

Everything else is derived from four instants. The sleep state machine produces
a hypnogram (`sleep_segments`, one state per contiguous interval) and
`compute_metrics` reads the anchors off it:

| Anchor | Definition in code |
|---|---|
| **bedtime** | start of the in-bed run containing the night's sleep |
| **sleep onset** | start of the *first* segment whose state counts as asleep |
| **final wake** | end of the *last* segment whose state counts as asleep |
| **out of bed** | end of that same in-bed run |

"In bed" is `awake`, `settling`, `restless` or `asleep`. "Asleep" is `asleep`
or `restless` — a child who is moving and vocalising but has not woken is still
asleep, which is why `restless_min` is tracked separately rather than counted
as wake.

Two things narrow the segments the anchors are read off, and both exist
because a `night_of` key covers a whole local day rather than just the night.

**The nocturnal cut.** Segments ending before the start of
`sleep.bedtime_window` are the day's naps and are excluded; one straddling the
cut is clipped to it. Without this an afternoon nap under the same key becomes
the night's bedtime and sleep onset, and the whole afternoon between nap and
bedtime is counted as wake after sleep onset. It is the same instant naps are
counted up to, so no minute of sleep is counted both as a nap and as night
sleep. If nothing survives the cut — a child put down ill at 15:00 — the cut is
ignored and the night is measured rather than discarded.

**The rest interval.** Bedtime is not simply the first in-bed segment left
after the cut: the search runs outwards from the night's sleep and stops at
`absent` or at a gap in the record. A child who plays in their room after
breakfast would otherwise stretch time in bed across the morning. What this
cannot do is tell a child lying awake in bed from one playing on the bedroom
floor — the state machine calls both `awake` — so an early-evening play session
in the bedroom does count towards time in bed. Setting the start of
`sleep.bedtime_window` to when the child actually goes up is the remedy.

Any of the four can be overridden by hand (`PATCH /api/nights/{night_of}`).
An override is honoured and **everything downstream is recomputed against it**;
`compute_metrics` takes an `overrides` dict and substitutes before deriving
anything. This is the intended way to fix a night the detector got wrong.

### The metrics

All in minutes unless stated. `MINUTE_MS = 60000`; a duration whose end is not
strictly after its start is `None`, not zero.

| | Formula | Notes |
|---|---|---|
| **TIB** | `out_of_bed − bedtime` | Time in bed. |
| **SPT** | `final_wake − sleep_onset` | Sleep period time. |
| **SOL** | `max(0, sleep_onset − bedtime)` | Sleep onset latency — how long it took to go down. |
| **TST** | Σ of sleep-state time **clipped to `[onset, final_wake]`** | Total sleep time. Not `SPT − WASO` by construction; WASO is derived from it. |
| **WASO** | `max(0, SPT − TST)` | Wake after sleep onset, *strictly inside* the sleep period. Excludes settling before onset and anything after the final wake. |
| **TASAFA** | `max(0, out_of_bed − final_wake)` | Time awake after final awakening — lying in bed awake in the morning. |
| **Awakenings** | count of maximal wake runs inside `[onset, final_wake]` of length ≥ `sleep.awakening_min_min` (default 5 min) | |
| **Stirrings** | total wake runs − awakenings | The short disturbances, counted but not held against the night. |
| **Longest bout** | `max(bouts)` over contiguous sleep runs inside the sleep period | For a small child, the number a parent actually cares about. A gap in the record breaks a bout: an unobserved stretch is not evidence of unbroken sleep. |
| **Restless** | Σ time in state `restless` inside the sleep period | |
| **Midpoint** | `sleep_onset + (final_wake − sleep_onset) // 2` | Integer division; the circadian anchor. |
| **Motion index** | mean of `sample.motion` for samples with `onset ≤ ts < final_wake` | |

### Sleep efficiency — both denominators

This one is reported twice on purpose, because the choice of denominator
changes the number materially and both are defensible:

```
SE_TIB = min(1.0, TST / TIB)        # `sleep_efficiency`     — the column, and the score input
SE_SPT = min(1.0, TST / SPT)        # `sleep_efficiency_spt` — in score_components
```

`SE_TIB` is what consumer trackers report. It penalises a long settle: an hour
of fighting bedtime drags it down even if the sleep that followed was perfect.
`SE_SPT` measures pure continuity once asleep and ignores the settle entirely.
A toddler who takes 45 minutes to go down and then sleeps solidly will show
something like SE_TIB 0.85 / SE_SPT 0.99, and those two numbers together say
something neither says alone.

Both are capped at 1.0, because a rounding artefact producing 100.3% efficiency
is worse than losing three decimal places.

### Fragmentation index

```
fragmentation_index = 60 × awakenings / (TST_min / 60)
```

As written, that is sixty times the awakenings-per-hour rate. It is a
**relative index** — comparable between nights for the same child — not a rate
you can quote to anyone. Only computed when SPT and TST are both positive.

### Environment and noise summaries

Computed over **every sample supplied for the night**, not just the sleep
period: `temp_c_mean` / `min` / `max`, `humidity_mean`, `mean_dbfs` (mean of
per-interval mean level) and `peak_dbfs` (max of per-interval peak level).

Event tallies skip anything the user marked a false positive
(`corrected_label == ""`), because counting the detector's mistakes would make
the tallies describe the detector rather than the night. Only `kind == audio`
events count toward `noise_events`; `cry_events` and `cry_min` count the subset
whose effective label is in `CRY_LABELS` = {`cry`, `scream`, `whimper`,
`fuss`}.

### Coverage

`coverage` is the fraction of the night the sensors were actually reporting,
0–1. Below `scoring.min_coverage` (0.6) the night is marked `partial`, no
quality score is produced, and it is left out of the analytics by default.

---

## Part 2 — Age bands

AASM consensus recommendations (Paruthi et al., *J Clin Sleep Med*
2016;12(6):785–786), endorsed by the AAP. **Per 24 hours, naps included.**

| Band | Age | Recommended | Scored? |
|---|---|---|---|
| Newborn | 0–121 days | 14–17 h | **no** |
| Infant | 122–364 days | 12–16 h | yes |
| Toddler | 365–1094 days | 11–14 h | yes |
| Preschool | 1095–2189 days | 10–13 h | yes |
| School age | 2190–4744 days | 9–12 h | yes |
| Teen | 4745+ days | 8–10 h | yes |

**Under four months there is no band and no score.** The AASM declined to make
a recommendation below four months on the grounds that the evidence is
insufficient and normal variation is very wide, and babymon follows that
exactly: `AgeBand.scoreable` is `False` for the newborn band and `score_night`
returns `None` with the reason *"Under four months old. Sleep at this age
varies too widely for a score to mean anything, so only the raw measurements
are shown."*

Producing a number there and hedging it in a caveat nobody reads would be
worse than producing nothing. The raw metrics are all still recorded and
charted.

With no birthdate set there is no band either, so the duration component is
dropped and a note says so.

---

## Part 3 — The quality score

A single 0–100 number, four components, each itself 0–100, combined as a
weighted mean.

### Guard conditions

`score_night` returns `None` — with a human-readable `suppressed_reason` — when:

1. the age band is not scoreable (under four months);
2. `coverage < scoring.min_coverage` (0.6): *"The sensors only covered 43% of
   this night (at least 60% is needed for a score)."*;
3. `tst_min is None` — no sleep was detected;
4. no weighted component could be computed at all.

### Missing components are dropped, not guessed

This is the design decision that matters most:

> A component that cannot be computed is **dropped and the remaining weights
> renormalised**, rather than being given a neutral value.

Filling a gap with 50 would drag every incomplete night toward the middle and
hide exactly the nights worth looking at. So if timing regularity is not
available yet (it needs a week of history), the score is the weighted mean of
the other three, renormalised, plus a note: *"Scored without timing; the
remaining parts were reweighted rather than filled in with a guess."*

```
active     = { k : w  for k,w in weights if w > 0 and k in components }
normalised = { k : w / Σ(active) }
score      = clamp( Σ components[k] × normalised[k] , 0, 100 )
```

### Weights

```yaml
scoring:
  weights:
    duration:    0.40    # 24 h total sleep against the age band
    efficiency:  0.20    # TST / TIB
    continuity:  0.20    # WASO, awakenings, longest bout
    timing:      0.20    # sleep regularity index and midpoint consistency
    environment: 0.00    # temperature and humidity (opt-in)
```

Those are the values in `config/babymon.example.yaml` and also the built-in
defaults in `babymon.config.ScoringConfig`, so an install with no config file
at all scores identically to one using the shipped example. If a score looks
different from what you expect, check which weights are actually in force via
`GET /api/config`. They need not sum to 1; they are normalised.

The mix follows what consumer trackers converge on — duration dominant, then
continuity and efficiency — with **one substitution**. Those trackers spend
roughly a quarter of the score on sleep-stage composition, which a camera and a
microphone cannot see. That weight goes to timing regularity, which they can
see and which matters more in early childhood anyway.

`environment` is off by default. It is a real signal but it is a property of
the room rather than of the child's sleep, and mixing the two makes the score
harder to reason about. Turn it on if you want it.

### Component 1 — Duration (`_duration_subscore`)

Compared against the age band, over **24 hours**: night sleep plus any recorded
nap time.

```
total_h = (TST_min + max(0, nap_min)) / 60
slack   = 2.0 hours

total_h < low − slack        →  0
low − slack ≤ total_h < low  →  100 × (total_h − (low − slack)) / slack
low ≤ total_h ≤ high         →  100
high < total_h ≤ high + slack→  100 − 40 × (total_h − high) / slack
total_h > high + slack       →  60
```

**Deliberately asymmetric.** Undersleep falls linearly to zero over two hours,
because undersleep is the thing the band exists to flag. Oversleep floors at
60: sleeping past the upper bound is a much weaker signal and, in a small
child, usually means they were catching up or coming down with something rather
than that anything is wrong. A toddler (11–14 h) who slept 15 h scores 80; one
who slept 17 h scores 60; one who slept 9 h scores 0.

If no naps were recorded and the child is in the Infant, Toddler or Preschool
band, a note is attached: the recommended range is for a full 24 hours, so
scoring night sleep alone understates it.

### Component 2 — Efficiency

```
                     SE_TIB − floor
efficiency = clamp( ───────────────── × 100 , 0, 100 )
                     target − floor

infant (< 365 days):  floor 0.70, target 0.90
older:                floor 0.75, target 0.92
```

Below the floor, zero; at or above the target, 100. Infants get the gentler
pair because more night waking is normal at that age and a fixed adult-style
threshold would score every healthy infant badly.

### Component 3 — Continuity

The unweighted mean of up to three parts, each 0–100:

```
WASO         clamp( 100 × (1 − WASO / waso_max) )
             waso_max = 90 min (infant) or 60 min

Awakenings   clamp( 100 × (1 − max(0, A − ok) / (8 − ok)) )
             ok = 2 (infant) or 1;  8 is the "all the way to zero" point

Longest bout clamp( 100 × longest_bout_min / bout_target )
             bout_target = 360 min (infant) or 480 min
```

So an infant gets two "free" awakenings before the count starts costing
anything, and a six-hour unbroken stretch is full marks; an older child needs
eight hours for full marks and pays from the second awakening.

### Component 4 — Timing consistency

The unweighted mean of whichever of these two are available:

```
SRI              clamp( SRI )                                  # already 0–100 in practice
Midpoint spread  clamp( 100 × (1 − midpoint_sd_min / 90) )     # 90 min SD → 0
```

If neither is available a note says *"Timing consistency needs at least a week
of nights before it can be scored."*

**The Sleep Regularity Index** (Phillips et al., *Scientific Reports* 2017), as
implemented in `stats.sleep_regularity_index`:

```
                200
SRI = −100 + ─────────── × Σ  δ( s[i][j] , s[i+1][j] )
              N_compared    i,j
```

where `s[i][j]` is the sleep/wake state of day *i* at clock position *j*, the
sum runs over every pair of **consecutive** days and every epoch within a day,
and `δ` is 1 when the two agree. Epochs where either day is unknown drop out of
**both** the numerator and the denominator, so a sensor outage lowers
confidence rather than the score.

- **100** — every day identical.
- **0** — no better than chance.
- **negative** — consecutive days systematically opposed.

Unlike the standard deviation of bedtime, SRI counts naps and captures *when*
sleep happens rather than only how much — which is precisely the difference
that matters for a small child. It needs at least seven days before it
stabilises.

**Clock times are angles, not numbers.** The arithmetic mean of 23:50 and 00:10
is midday, which is a genuinely disastrous bug to have in a bedtime statistic.
Every clock-time statistic in babymon therefore goes through
`stats.circular_mean` and `stats.circular_sd`, which sum unit vectors at
`2π·minutes/1440` and convert back. `circular_sd` is `√(−2 ln R) × 1440/2π`,
the standard circular SD.

### Component 5 — Environment (opt-in)

Only computed when `weights.environment > 0`. The unweighted mean of a
temperature and a humidity band score:

```
_band_subscore(value, low, high, slack):
    inside the band          → 100
    outside                  → clamp( 100 × (1 − distance_outside / slack) )

temperature: comfort.temp_c_min .. temp_c_max      slack 3.0 °C
humidity:    comfort.humidity_min .. humidity_max  slack 15.0 %
```

Defaults are 19.0–21.5 °C and 40–60% RH.

### Bands

The UI shows the word and the four sub-scores, never the decimal — a single
number invites more trust than it deserves.

| Score | Band |
|---|---|
| ≥ 90 | Excellent |
| ≥ 80 | Good |
| ≥ 65 | Fair |
| < 65 | Poor |

The whole breakdown — components, the weights *actually used* after
renormalisation, and every note — is persisted in `nights.score_components` and
returned by the API, so a score can always be argued with.

---

## Part 4 — The factor analysis

`GET /api/analytics/factors` — "does dessert before bedtime wreck his sleep?"

This is the easiest place in the whole product to mislead someone, and a
disproportionate amount of the code exists to **refuse to answer**.

### What makes this hard

It is not the arithmetic. It is that the data is an N-of-1 observational time
series with every pathology at once.

**Autocorrelation.** Children have good weeks and bad weeks, and habits come in
runs. Under realistic AR(1) structure in *both* the outcome and the tag, a
nominal 5% test fires roughly 18% of the time. Nearly one in five "significant"
findings would be noise.

**Multiplicity.** Twenty tags on a screen is twenty tests. At α = 0.05 you
expect one false positive per screenful, and it will be the interesting one.

**Tiny samples.** At ten nights per group only effects large enough to be
obvious without statistics are detectable, and the ones that *do* reach
significance are biased upward in magnitude — the winner's curse.

**Confounding.** Dessert nights are also television nights are also weekend
nights. Nothing here can separate them.

**Age drift.** Over six months an infant's sleep changes profoundly on its own.
A tag used only in March cannot be told apart from "March".

**Reverse causality.** An extra nap may be a *response* to a bad night rather
than a cause of the next one.

Each of those has a specific countermeasure below.

### Which nights take part

Only nights where `Night.analysable` is true: **not excluded**, status
**`complete`**, and **a quality score exists**. Note the third condition — a
night with no score (under four months, or coverage below 0.6) never enters the
statistics at all, whichever outcome metric you selected.

Then two hard floors, both configurable and both defaulting to values chosen on
statistical rather than aesthetic grounds:

```yaml
analytics:
  min_nights_total: 20         # analysable nights in the window, or nothing runs
  min_nights_per_group: 10     # nights WITH the tag and nights WITHOUT
```

Below `min_nights_total` the whole analysis is blocked with an explanation.
Below `min_nights_per_group` on either side, that tag goes into the
`insufficient` list with a countdown: *"3 more nights with this tag before
there is enough to compare."* The UI shows a progress counter instead of a
number.

**Why ten.** It is not a round number picked for tidiness. Below ten per side
the only effects detectable at 80% power are ones so large you would have
noticed them without statistics — and among the few that do reach significance,
the observed effect size is systematically inflated, because only the
lucky-large estimates clear the bar. Setting it lower produces a screen full of
confident nonsense; `config.py` emits a warning if you do.

Realistically: **about a month of consistent logging before your first answer**,
longer for a tag you only apply twice a week.

### The test: circular-shift permutation

The p-value comes from `stats.permutation_test`, default mode
`circular_shift`.

The textbook null shuffles the labels freely, which assumes the nights are
exchangeable. They are not — that is the autocorrelation problem above, and
free shuffling is what turns a 5% test into an 18% one.

**A circular shift rotates the tag vector by a random offset instead.** Night
*i*'s label goes to night *i+k* (mod n). This destroys the alignment between
tag and outcome, which is what a null needs to do, while preserving *both* the
tag's own run structure and the outcome's autocorrelation. Most of the
inflation goes away.

Two honest limitations, both handled in the code:

- **There are only `n` distinct rotations.** The p-value cannot resolve finer
  than about `1/n`. With 60 nights, the smallest p you can observe is about
  0.016.
- **Below 30 nights, rotation is too coarse to say anything**, so the
  implementation silently falls back to free shuffling. `TestResult.method`
  records which was actually used.

Every permutation p-value is computed as

```
p = (1 + #{|statistic(permuted)| ≥ |statistic(observed)|}) / (1 + iterations)
```

The `1 +` on both sides is not a fudge: a permutation p-value of exactly zero
is never a valid estimate (Phipson & Smyth 2010). With the default
`permutations: 10000` the floor is 1e-4.

`analytics.permutation_mode: shuffle` is available because it is the textbook
null, not because it is the right one here — and `config.py` warns when you
select it.

### Multiplicity: Benjamini-Hochberg

`stats.benjamini_hochberg(p_values, q)` with `analytics.fdr_q: 0.10`.

BH controls the **false discovery rate**: of the results you call significant,
no more than *q* of them are expected to be false. That is a different and much
more useful promise than familywise error control (Bonferroni), which asks that
*no* false positive occur anywhere and, at twenty tags, is so conservative that
nothing short of a catastrophe survives.

Two details the implementation is careful about:

- **The step-up rule.** Having found the largest rank *k* with
  `p₍ₖ₎ ≤ (k/m)·q`, **every** hypothesis of rank 1..*k* is rejected —
  including ones whose own p-value exceeds their own threshold. Rejecting only
  those that individually pass is a common and wrong implementation.
- **`m` is the number of tests actually run, not the number displayed.**
  Evaluating forty tags and showing you the best three is still forty tests,
  and correcting for three would be cheating.

`q = 0.10` rather than 0.05 because this is exploratory personal analytics, not
confirmatory research. One in ten of the flagged results is expected to be
noise, and that is the deal being offered.

The dose-response correlation for numeric tags (below) deliberately does **not**
enter this correction, because it answers a different question on a subset of
the data.

### Effect sizes

**Hedges' g** — Cohen's *d* with the exact small-sample correction:

```
d = (mean_with − mean_without) / s_pooled
J = exp( lgamma(m/2) − ½·ln(m/2) − lgamma((m−1)/2) ),   m = n₁+n₂−2
g = J · d
Var(d) = (n₁+n₂)/(n₁n₂) + d²/(2(n₁+n₂))          # Hedges & Olkin
SE(g)  = J · √Var(d)
CI     = g ± 1.96 · SE(g)
```

The exact `lgamma` correction rather than the familiar `1 − 3/(4m−1)`
approximation; they agree to three decimals even at m = 8, but the exact form
costs nothing. Magnitude labels use Cohen's conventions
(<0.2 negligible, <0.5 small, <0.8 medium, else large).

**Cliff's delta** — `P(x > y) − P(x < y)`, distribution-free, with Cliff's
(1993) consistent-variance asymmetric interval. It is here because WASO and
sleep-onset latency have heavy right tails that make a mean difference
misleading; delta only cares about ordering. Magnitude thresholds are Romano et
al. (2006): <0.147 negligible, <0.33 small, <0.474 medium, else large.

**The headline difference in natural units** ("11 minutes less sleep") is what
people actually read, so *that* is what gets the confidence interval: a
percentile bootstrap of the mean difference, `analytics.bootstrap_iterations`
(5000) resamples of each group independently.

### Shrinkage

`analytics.shrinkage: true` (default). Empirical-Bayes, DerSimonian-Laird:

```
τ²  = max(0, Var(all g's) − mean(SE²))
gᵢ' = gᵢ × τ² / (τ² + SEᵢ²)
```

**Why.** Without it, the top of any factor list is reliably whichever tag has
the fewest nights, because small samples produce large estimates. Each estimate
is pulled toward zero in proportion to how much of its own variance is noise: a
precise estimate barely moves, a noisy one collapses. If the whole family's
spread is explicable as sampling noise (τ² ≤ 0), every effect shrinks to
exactly zero — the honest answer to "nothing here is distinguishable from
chance". With fewer than three tags there is no family to borrow strength from
and the raw estimates pass through.

The **ranking uses the shrunken effect**, so a noisy small sample cannot buy
its way to the top of the list. The unshrunken `effect_size` is still reported.

### Confounding

`stats.phi_coefficient` between every pair of tags' presence vectors (the
Matthews correlation on binary data). Above
`analytics.confound_phi_threshold` (0.3) each tag lists the others it travels
with and gains a caveat:

> *"Usually happens on the same nights as Screen Before Bed, Weekend, so their
> effects cannot be separated."*

Above `duplicate_phi_threshold` (0.6) they are near-duplicates and the UI
offers to merge them. This is a warning, not a correction — nothing here can
disentangle two habits that always co-occur, and pretending otherwise with a
regression on 30 nights would be worse than saying so.

### Age drift

`span_fraction` is the fraction of the window between a tag's first and last
use. Below `analytics.min_span_fraction` (0.4):

> *"All of these nights fall in one stretch of the record, so this cannot be
> told apart from other things that changed over time."*

### Reverse causality

For any tag whose main p-value is ≤ 0.10, the tag vector is shifted by one
night and the test is re-run against the *previous* night's outcome. If the
lagged association is about as strong (`lag_p ≤ max(0.05, p × 1.5)`):

> *"This tag lines up with the previous night's sleep about as strongly as with
> its own, which usually means something else is driving both."*

An extra nap logged after a bad night would otherwise look like a cause of the
next one. The check only runs on tags that found something — warning that a
null result might also be a null result for the wrong reason is noise.

### Dose-response, for tags carrying a number

For `number`, `duration` and `time` tags, a second and narrower question:
*"were nights with **more** screen time worse still?"*

Computed over the nights the tag was applied to only, and requiring at least 8
such nights and at least 3 distinct values (fewer distinct values is a boolean
wearing a number's clothes).

- **Spearman's ρ**, not Pearson: these relationships are rarely linear and one
  unusual night should not set the correlation. Reported with a Fisher-*z*
  interval, `tanh(z ± 1.96/√(n−3))`, which behaves far better on ρ than a
  normal interval.
- **Theil-Sen slope** (`slope_per_unit`), the median of all pairwise slopes,
  for the same reason: one illness or one holiday would drag a least-squares
  fit around.

It is reported **alongside** the group comparison, never in place of it, and it
does **not** enter the BH correction — otherwise the headline verdict for a
duration tag would be driven by a test on a fraction of the data.

`time` tags are stored as minutes after local midnight and may exceed 1440 or
go negative, so "lights off at 00:15" and "lights off at 23:45" come out thirty
minutes apart rather than twenty-three and a half hours.

### Verdicts and tiers

The verdict vocabulary has **no word for "causes"**.

```
verdict = "inconclusive"   if diff is None
                           or the bootstrap CI includes 0
                           or BH did not reject
          "better"/"worse" otherwise, oriented by whether lower is better
                           for this metric
```

Lower is better for: `waso_min`, `sol_min`, `awakenings`, `cry_events`,
`cry_min`, `noise_events`, `motion_index`, `restless_min`. Higher is better for
everything else.

Note that a result can be BH-significant and still come out `inconclusive` if
the bootstrap interval on the natural-units difference straddles zero. Two
different resamplings can disagree at the margin, and when they do, the
cautious reading wins.

Evidence tier, from the smaller group's size alone:

| Tier | Condition |
|---|---|
| `insufficient` | smaller group < `min_per_group` |
| `exploratory` | smaller group < 30 |
| `suggestive` | smaller group ≥ 30 |
| `notable` | smaller group ≥ 50 **and** BH-significant |

Every result also carries a plain-English `summary` with no causal verbs:

> *"On nights with dessert before bedtime, the figure was 11 points less
> (95% CI −16 to −5), across 23 nights with and 108 without."*

and, when the interval includes zero, *"That range includes no difference at
all, so this could easily be chance."*

### Other statistics available

`stats.py` also implements Welch's t-test (always Welch, never Student — the
two groups differ in size and spread essentially by construction) and
Mann-Whitney U with tie correction. The factor engine does not use their
p-values; the permutation test replaces them, for the autocorrelation reason
above. They are used elsewhere and kept as a cross-check —
`tests/test_stats_vs_scipy.py` runs a randomised differential comparison
against scipy whenever scipy happens to be installed, so the hand-rolled
mathematics cannot drift unnoticed.

There is no scipy at runtime, deliberately: on a 64-bit Pi it means a 33 MB
wheel (piwheels has no aarch64 build) unpacking to well over 100 MB, plus
numpy/scipy ABI pinning, for arithmetic that runs in microseconds without it at
n ≤ 200 nights.

---

## Part 5 — What this cannot tell you

Read this part.

**It is not causal. It cannot be.** Everything above is an association in one
child's observational record. There is no randomisation, no control, no
blinding. The disclaimer attached to every response says it plainly:

> *"These are associations in your own data, not causes. They show what tended
> to happen on nights you logged something — many things change together, and a
> pattern here is a hint worth watching, not an explanation. This is not
> medical advice or a medical device."*

**A significant result is a hypothesis, not a finding.** The correct response
to "dessert before bed is associated with 11 fewer minutes of sleep" is not to
ban dessert. It is: *stop giving dessert for three weeks, keep logging, and see
whether the pattern holds.* That is closer to an experiment, and it is the only
thing in reach that gets you nearer to a cause. Alternate weeks if you can — a
real N-of-1 crossover, and far stronger than anything the observational
analysis can offer.

**One in ten flagged results is expected to be wrong.** That is what
`fdr_q: 0.10` buys and it is the deal being offered. Chasing every flag is how
you end up with a bedtime routine built on noise.

**The confounders are usually the real story.** Dessert nights are weekend
nights are late-bedtime nights are grandparents-visiting nights. babymon flags
tags that co-occur, and that flag deserves more of your attention than the
p-value next to it.

**You choose which nights get tagged, and you are not a random sampler.** You
are more likely to log "teething" on a night that already went badly, which
manufactures an association out of nothing. Tag the routine, not the outcome,
and tag it at the time rather than in the morning.

**A tag that only appears in one stretch of the record is confounded with
time**, and over six months of a small child's life, time is the largest
effect in the dataset by a wide margin. Nothing can separate them; the
`span_fraction` caveat only tells you that.

**The outcome itself is inferred, not measured.** A child lying perfectly still
awake in the dark scores as asleep. A child who thrashes in their sleep scores
as restless or awake. There are no sleep stages. TST from actigraphy typically
overestimates against polysomnography, and the size of that bias varies by
child. Comparing your child's TST to a published norm is a much shakier
operation than comparing this week's TST to last week's — **use these numbers
as relative, longitudinal signals about one child, not as absolute
measurements.**

**Fewer tags, logged consistently, beat many tags logged sporadically.** Every
extra tag is another test in the multiplicity correction, which raises the bar
for all of them. Five things you log every single night will find something
real long before twenty things you log when you remember.

**None of this is medical advice, and none of it is a medical device.** If
something about your child's sleep or breathing worries you, that is a
conversation with your paediatrician, not with a dashboard.
