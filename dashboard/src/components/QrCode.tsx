/**
 * A QR code, rendered as inline SVG from {@link encodeQr}.
 *
 * Always dark-on-white, in both themes. That is deliberate and not an
 * oversight: an inverted QR code (light modules on a dark ground) is legal but
 * a good number of camera apps — including some iOS versions — will not lock
 * onto one, and the entire job of this component is to be scanned on the first
 * try by someone holding a phone in a dim nursery. The white card is what gets
 * the quiet zone, so it reads correctly against a near-black page.
 */

import { useMemo } from 'react';
import { encodeQr, qrPath, qrViewBoxSize } from '../lib/qr';
import './QrCode.css';

export interface QrCodeProps {
  /** The payload. For HomeKit this is the `X-HM://…` setup URI. */
  value: string;
  /** Rendered side length in CSS pixels. The SVG itself is resolution-free. */
  size?: number;
  /**
   * Accessible name. A QR code is an image of a string, and reading the string
   * aloud is useless, so this should say what it is *for*.
   */
  label: string;
  className?: string;
}

export function QrCode({ value, size = 200, label, className }: QrCodeProps) {
  const drawing = useMemo(() => {
    if (!value) return null;
    try {
      const matrix = encodeQr(value);
      return { path: qrPath(matrix), box: qrViewBoxSize(matrix) };
    } catch {
      // Nothing this dashboard encodes should overflow a version-10 symbol,
      // but a QR code is never the only way to read a setup code — the caller
      // shows the digits too — so a failure here is silent rather than fatal.
      return null;
    }
  }, [value]);

  if (!drawing) return null;

  return (
    <svg
      className={['qr', className ?? ''].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox={`0 0 ${drawing.box} ${drawing.box}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={drawing.box} height={drawing.box} fill="#ffffff" stroke="none" />
      <path d={drawing.path} fill="#000000" stroke="none" />
    </svg>
  );
}
