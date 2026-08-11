import { useState } from 'react';
import { media as mediaApi } from '../lib/api';
import { formatDurationSeconds } from '../lib/format';
import type { MediaRef } from '../lib/types';
import './ClipPlayer.css';

export interface ClipPlayerProps {
  /** The `media` array from an event. Empty or absent renders nothing. */
  clips: readonly MediaRef[] | undefined;
  /** Accessible context, e.g. "Cry at 23:14". */
  label: string;
  className?: string;
}

/**
 * The audio or video attached to an event.
 *
 * Nothing loads until it is asked for. A night can carry a hundred events, and
 * a hundred `<audio preload="metadata">` elements would have the Pi serving a
 * hundred range requests the moment the page opens — on hardware that is also
 * encoding video. So each clip is a button first and a player second.
 *
 * Playback uses the native controls on purpose: they come with a working
 * scrubber, a keyboard interface, OS media keys and a screen-reader
 * implementation, none of which a hand-built transport would match.
 */
export function ClipPlayer({ clips, label, className }: ClipPlayerProps) {
  if (!clips || clips.length === 0) return null;
  return (
    <div className={['clips', className ?? ''].filter(Boolean).join(' ')}>
      {clips.map((clip) => (
        <Clip key={clip.id} clip={clip} label={label} />
      ))}
    </div>
  );
}

function Clip({ clip, label }: { clip: MediaRef; label: string }) {
  const [active, setActive] = useState(false);
  const src = mediaApi.fileUrl(clip.id);
  const duration = formatDurationSeconds(clip.duration_s, { style: 'hms' });
  const kindWord =
    clip.kind === 'audio_clip' ? 'audio' : clip.kind === 'video_clip' ? 'video' : 'snapshot';

  if (!active) {
    return (
      <button type="button" className="clips__load" onClick={() => setActive(true)}>
        <span className="clips__play" aria-hidden="true">
          ▶
        </span>
        <span className="clips__load-text">
          Play {kindWord}
          {clip.duration_s ? <span className="clips__duration"> · {duration}</span> : null}
        </span>
        <span className="visually-hidden">of {label}</span>
      </button>
    );
  }

  if (clip.kind === 'snapshot') {
    return <img className="clips__image" src={src} alt={`Snapshot from ${label}`} loading="lazy" />;
  }

  if (clip.kind === 'video_clip') {
    return (
      <video
        className="clips__video"
        src={src}
        controls
        autoPlay
        playsInline
        preload="metadata"
        aria-label={`Video of ${label}`}
      />
    );
  }

  return (
    <audio
      className="clips__audio"
      src={src}
      controls
      autoPlay
      preload="metadata"
      aria-label={`Audio of ${label}`}
    />
  );
}
