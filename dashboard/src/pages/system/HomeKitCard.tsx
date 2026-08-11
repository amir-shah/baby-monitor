/**
 * The HomeKit pairing card.
 *
 * The Home app will accept either the QR code or the eight digits typed in by
 * hand, and both are shown, because the QR is useless on the device that is
 * displaying it — pairing from the same phone that is reading this dashboard
 * means reading the digits. The setup URI is offered as text as well, so it
 * can be copied into a note or a support message.
 *
 * A fresh install has never published the accessory, so there is no
 * `AccessoryInfo` file to read. That is a normal state, not an error, and it
 * is what `published: false` means — the card says so rather than showing an
 * empty box.
 */

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Skeleton,
  describeError,
  useToast,
} from '../../components';
import { QrCode } from '../../components/QrCode';
import { homekit } from '../../lib/api';
import { asRecord } from './normalize';
import './HomeKitCard.css';

export function HomeKitCard() {
  const toast = useToast();

  const pairingQuery = useQuery({
    queryKey: ['homekit', 'pairing'],
    queryFn: ({ signal }) => homekit.pairing(signal),
    staleTime: 30_000,
    retry: 1,
  });

  if (pairingQuery.isPending) {
    return (
      <Card title="HomeKit">
        <div aria-busy="true" className="hk__loading">
          <span className="visually-hidden">Loading pairing details</span>
          <Skeleton height="11rem" shape="block" width="11rem" />
          <Skeleton height="2rem" shape="block" />
        </div>
      </Card>
    );
  }

  if (pairingQuery.error) {
    const described = describeError(pairingQuery.error);
    return (
      <Card title="HomeKit">
        <ErrorState
          error={pairingQuery.error}
          size="sm"
          title={described.title}
          description="The bridge may not be running, or HomeKit may be switched off in the configuration."
          onRetry={() => void pairingQuery.refetch()}
        />
      </Card>
    );
  }

  const pairing = pairingQuery.data;
  const extra = asRecord(pairing);
  const enabled = typeof extra?.enabled === 'boolean' ? extra.enabled : true;
  const published = typeof extra?.published === 'boolean' ? extra.published : null;
  const controllers =
    pairing.paired_controllers ??
    (typeof extra?.paired_clients === 'number' ? extra.paired_clients : null);

  const setupUri = pairing.setup_uri ?? pairing.qr_payload;
  const setupCode = pairing.setup_code;

  return (
    <Card
      title="HomeKit"
      subtitle={pairing.accessory_name ?? 'Baby Monitor'}
      actions={
        <Badge tone={pairing.paired ? 'success' : 'neutral'} dot>
          {pairing.paired ? 'Paired' : 'Not paired'}
        </Badge>
      }
    >
      {!enabled ? (
        <p className="hk__note">
          HomeKit is switched off in the configuration (<code>homekit.enabled</code>). Turn it on and
          restart the bridge to pair.
        </p>
      ) : null}

      <div className="hk">
        {setupUri ? (
          <div className="hk__code">
            <QrCode
              value={setupUri}
              size={180}
              label="HomeKit pairing code. Scan it with the Home app, or type the eight digits shown beside it."
            />
          </div>
        ) : null}

        <div className="hk__details">
          <div className="hk__pin">
            <p className="hk__pin-label">Setup code</p>
            <p className="hk__pin-value" data-numeric>
              {setupCode ?? '—'}
            </p>
            {setupCode ? (
              <Button variant="ghost" size="sm" onClick={() => void copy(setupCode, toast.success, toast.error)}>
                Copy code
              </Button>
            ) : null}
          </div>

          <dl className="hk__facts">
            {pairing.setup_id ? (
              <>
                <dt>Setup ID</dt>
                <dd data-numeric>{pairing.setup_id}</dd>
              </>
            ) : null}
            {controllers !== null ? (
              <>
                <dt>Paired controllers</dt>
                <dd data-numeric>{controllers}</dd>
              </>
            ) : null}
            {published !== null ? (
              <>
                <dt>Accessory published</dt>
                <dd>{published ? 'Yes' : 'Not yet — the bridge has not run'}</dd>
              </>
            ) : null}
          </dl>

          {setupUri ? (
            <div className="hk__uri">
              <p className="hk__uri-label">Setup URI</p>
              <code className="hk__uri-value">{setupUri}</code>
            </div>
          ) : null}
        </div>
      </div>

      <p className="hk__note">
        {pairing.paired
          ? 'Already paired. To pair another home, remove the accessory in the Home app first — the code above stays the same.'
          : 'In the Home app: Add Accessory, then scan this code or enter the digits by hand.'}
      </p>
    </Card>
  );
}

/**
 * Clipboard access needs a secure context, and the Pi is very often served
 * over plain HTTP on a LAN — so the failure path is real and gets a message
 * rather than nothing happening.
 */
async function copy(
  text: string,
  onSuccess: (message: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onSuccess('Setup code copied.');
  } catch {
    onError('This browser would not let the page copy. Select the code and copy it by hand.');
  }
}
