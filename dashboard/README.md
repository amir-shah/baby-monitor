# babymon dashboard

The web UI for [babymon](../README.md). Vite + React 18 + TypeScript, served by
the Python API from `paths.static_dir` once built.

It is designed for two situations: a phone at 3am in a dark bedroom, and a
laptop over morning coffee. That is why the theme defaults to dark, the
typography is large and calm, and the primary navigation is a bottom bar
within thumb reach.

## Quick start

```sh
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` to `http://127.0.0.1:8080`, so run the Python
service alongside it:

```sh
cd ../pi && .venv/bin/python -m babymon.api    # or however you start it
```

Point the proxy somewhere else — a real Pi on the LAN, say — with an
environment variable:

```sh
BABYMON_API_URL=http://nursery.local:8080 npm run dev
```

Because the proxy keeps the request same-origin, the session cookie works and
CORS never enters into it. `/api/stream/events` (SSE) and `/api/stream/mjpeg`
(multipart) stream through the proxy unbuffered.

## Scripts

| Script              | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `npm run dev`       | Dev server with HMR and the `/api` proxy                    |
| `npm run build`     | Type-check, then build to `dist/`                           |
| `npm run typecheck` | `tsc --noEmit` over both tsconfigs                          |
| `npm run lint`      | ESLint over `src` and the config files                      |
| `npm run preview`   | Serve `dist/` locally, with the same proxy                  |

## Deploying to the Pi

`npm run build` writes a self-contained `dist/`: one HTML file, one JS chunk,
one CSS file, one SVG favicon. Copy it wherever `paths.static_dir` points and
the API will serve it:

```sh
npm run build
rsync -a --delete dist/ pi@nursery.local:/var/lib/babymon/static/
```

`base` is `/` because the API mounts the dashboard at the site root.

## Layout

```
src/
  lib/
    api.ts          typed client for every endpoint in docs/API.md,
                    plus the reconnecting SSE wrapper (EventStream)
    types.ts        TypeScript mirror of docs/API.md and pi/babymon/models.py
    format.ts       durations, clock times, night labels, dBFS, percentages
    scales.ts       linear/time/band scales, ticks, useResizeObserver
    stateStyles.ts  vocabulary -> CSS class mapping
  styles/
    tokens.css      every design token, for both themes
    base.css        reset and base element styles
  components/       the shared kit (AppShell, Card, Stat, Button, …)
  hooks/            useTheme, useEventStream
  pages/            one file per route
```

### Conventions worth knowing before you add code

**No remote anything.** The Pi may sit on a LAN with no route to the
internet. No CDN, no webfont, no icon package — the font stack is system-only
and icons are inline SVG in `components/Icons.tsx`.

**Charts are hand-written SVG.** `lib/scales.ts` has the ten lines of scale
maths a chart needs. Do not add recharts, d3 or chart.js; these charts are
specific enough that a library costs more than it saves, and the bundle has to
stay small.

**Styling is plain CSS with custom properties.** Tokens live in
`styles/tokens.css`; each component has a sibling `.css` file next to it. No
Tailwind, no CSS-in-JS.

**Both themes, always.** Light values are defined on bare `:root`, dark values
are repeated under both `@media (prefers-color-scheme: dark)` and
`:root[data-theme="dark"]` so a manual choice wins in either direction. If you
add a colour, add it to every block. `index.html` hardcodes `data-theme="dark"`
and runs a pre-paint script, so a phone opened at 3am never flashes white.

**Colour is never the only signal.** Sleep states differ by dash pattern and
always render their name; severity gets a glyph; the active nav item has a rule
as well as a tint. Assume greyscale.

**Nulls are normal.** A sensor can be offline and a night can be in progress,
so every formatter in `lib/format.ts` takes `number | null | undefined` and
returns an em dash. Nothing should ever render `NaN` or `undefined`.

**Timestamps are epoch milliseconds; nights are local dates.** `night_of` is
the local calendar date a night began, which is why every wall-clock formatter
takes an IANA timezone. Set the active child's zone once with
`setDefaultTimezone()` and omit it afterwards.

## Accessibility floor

These are requirements, not aspirations:

- Every icon-only control has an `aria-label` (`IconButton` makes it required).
- Focus is never suppressed; `:focus-visible` gets a two-tone ring that stays
  visible on any surface.
- Contrast clears WCAG AA in both themes for body text and UI chrome.
- `prefers-reduced-motion` zeroes the duration tokens at source, so every
  transition built on them stops.
- The modal traps Tab, restores focus to its opener, and closes on Escape.
- Live regions are used sparingly: polite for confirmations, assertive only for
  errors.
