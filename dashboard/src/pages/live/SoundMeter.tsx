/**
 * The sound meter.
 *
 * A raw dBFS number is useless to a parent — is −54 loud? It depends entirely
 * on the room, the mic gain and the time of night. What matters is the reading
 * *relative to the adaptive noise floor*, so that is what the bar shows: the
 * floor is marked, and the stretch of bar past it is the part that means
 * something. That excess is hatched as well as tinted, so it survives a
 * greyscale screen, and it is named in words above the bar.
 */

import { SoundIcon } from '../../components/Icons';
import { formatDb, formatPercent } from '../../lib/format';
import { Sparkline } from './Sparkline';
import type { SoundPoint } from './useLiveState';
import './SoundMeter.css';

/**
 * Bar domain. −72 dBFS is below the floor of any room quiet enough to sleep
 * in, and 0 dBFS is digital full scale, so a real reading always lands inside.
 */
const MIN_DBFS = -72;
const MAX_DBFS = 0;

/** Above this the classifier is confident enough to say the word "crying". */
const CRY_THRESHOLD = 0.5;

export interface SoundMeterProps {
  dbfs: number | null;
  floor: number | null;
  aboveFloor: number | null;
  cryScore: number | null;
  audioOnline: boolean | undefined;
  history: readonly SoundPoint[];
  windowMs: number;
  now: number;
}

interface Level {
  word: string;
  tone: 'calm' | 'notice' | 'alert';
}

/**
 * How far above the floor counts as what. The bands are wide on purpose: a
 * meter that flickers between two words every fifteen seconds is worse than
 * one that is slightly coarse.
 */
function describeLevel(aboveFloor: number | null): Level {
  if (aboveFloor === null) return { word: 'No reading', tone: 'calm' };
  if (aboveFloor < 2) return { word: 'Silent', tone: 'calm' };
  if (aboveFloor < 6) return { word: 'Quiet', tone: 'calm' };
  if (aboveFloor < 12) return { word: 'Rustling', tone: 'notice' };
  if (aboveFloor < 20) return { word: 'Noisy', tone: 'notice' };
  return { word: 'Loud', tone: 'alert' };
}

function positionPct(value: number): number {
  const fraction = (value - MIN_DBFS) / (MAX_DBFS - MIN_DBFS);
  return Math.min(100, Math.max(0, fraction * 100));
}

export function SoundMeter({
  dbfs,
  floor,
  aboveFloor,
  cryScore,
  audioOnline,
  history,
  windowMs,
  now,
}: SoundMeterProps) {
  if (audioOnline === false) {
    return (
      <p className="meter__offline">
        <SoundIcon size={18} />
        The microphone is not running, so there is no sound to show.
      </p>
    );
  }

  // `sound_above_floor_db` is served pre-computed, but it can be absent while
  // both halves are present (or vice versa), so derive whichever is missing.
  const excess = aboveFloor ?? (dbfs !== null && floor !== null ? dbfs - floor : null);
  const level = describeLevel(excess);
  const crying = cryScore !== null && cryScore >= CRY_THRESHOLD;

  const levelPct = dbfs === null ? 0 : positionPct(dbfs);
  const floorPct = floor === null ? null : positionPct(floor);
  const excessStart = floorPct === null ? null : Math.min(floorPct, levelPct);
  const excessWidth = floorPct === null ? 0 : Math.max(0, levelPct - floorPct);

  const valueText =
    excess === null
      ? 'No sound reading'
      : `${level.word}, ${formatDb(excess)} above the noise floor`;

  return (
    <div className="meter">
      <div className="meter__head">
        <p className={`meter__word meter__word--${level.tone}`}>{level.word}</p>
        <p className="meter__detail" data-numeric>
          {excess === null ? 'waiting for the microphone' : `${formatDb(excess)} above floor`}
        </p>
        {crying ? (
          <p className="meter__cry">
            <span aria-hidden="true">▲</span> Crying detected
            <span className="meter__cry-score" data-numeric>
              {formatPercent(cryScore)} confident
            </span>
          </p>
        ) : null}
      </div>

      {/* `meter` requires an `aria-valuenow`, so with no reading it becomes a
          plain labelled image rather than a meter that lies about its value. */}
      <div
        className="meter__bar"
        role={excess === null ? 'img' : 'meter'}
        aria-label={
          excess === null ? valueText : 'Sound level relative to the noise floor'
        }
        {...(excess === null
          ? {}
          : {
              'aria-valuemin': -10,
              'aria-valuemax': 40,
              'aria-valuenow': Math.round(Math.min(40, Math.max(-10, excess))),
              'aria-valuetext': valueText,
            })}
      >
        <div className="meter__track">
          {dbfs === null ? null : (
            <>
              <div className="meter__fill" style={{ inlineSize: `${levelPct}%` }} />
              {excessWidth > 0 && excessStart !== null ? (
                <div
                  className="meter__excess"
                  style={{ insetInlineStart: `${excessStart}%`, inlineSize: `${excessWidth}%` }}
                />
              ) : null}
            </>
          )}

          {floorPct === null ? null : (
            <div className="meter__floor" style={{ insetInlineStart: `${floorPct}%` }}>
              <span className="meter__floor-tick" />
            </div>
          )}
        </div>

        <p className="meter__scale" aria-hidden="true">
          <span>quiet</span>
          {floorPct === null ? null : (
            <span className="meter__floor-label" style={{ insetInlineStart: `${floorPct}%` }}>
              floor
            </span>
          )}
          <span>loud</span>
        </p>
      </div>

      <Sparkline points={history} now={now} windowMs={windowMs} />
    </div>
  );
}
