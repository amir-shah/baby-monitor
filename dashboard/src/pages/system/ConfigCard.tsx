/**
 * The effective configuration, summarised.
 *
 * Not a settings editor: babymon is configured from a YAML file and the
 * environment, and pretending otherwise would invite someone to change
 * something here and wonder why it reverted on restart. What this card is for
 * is answering "what is this Pi actually running with?" — the values that
 * explain the rest of the dashboard's behaviour, plus whatever the loader
 * complained about, plus the raw document for anything not listed.
 *
 * Secrets are redacted by the service before they reach us.
 */

import { Badge, Card } from '../../components';
import { formatDuration } from '../../lib/format';
import { configBool, configNumber, configString } from './normalize';
import type { ConfigView } from './normalize';
import './ConfigCard.css';

interface Fact {
  label: string;
  value: string;
  mono?: boolean;
}

export function ConfigCard({ config, source }: { config: ConfigView; source?: string | null }) {
  const groups = buildGroups(config.config);

  return (
    <Card
      title="Configuration"
      subtitle={
        source ? (
          <>
            Loaded from <code>{source}</code>. Secrets are redacted.
          </>
        ) : (
          'The effective configuration, with secrets redacted.'
        )
      }
    >
      {config.warnings.length > 0 ? (
        <ul className="config__warnings">
          {config.warnings.map((warning) => (
            <li key={warning}>
              <Badge tone="warning" size="sm">
                Warning
              </Badge>
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="config">
        {groups.map((group) => (
          <section className="config__group" key={group.title}>
            <h3 className="config__group-title">{group.title}</h3>
            <dl className="config__facts">
              {group.facts.map((fact) => (
                <div className="config__fact" key={`${group.title}-${fact.label}`}>
                  <dt>{fact.label}</dt>
                  <dd className={fact.mono ? 'config__value config__value--mono' : 'config__value'}>
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <details className="config__raw">
        <summary>Everything else, as it was loaded</summary>
        <pre className="config__json">{JSON.stringify(config.config, null, 2)}</pre>
      </details>
    </Card>
  );
}

function buildGroups(config: Record<string, unknown>): { title: string; facts: Fact[] }[] {
  const groups: { title: string; facts: Fact[] }[] = [];

  const add = (title: string, facts: (Fact | null)[]): void => {
    const kept = facts.filter((fact): fact is Fact => fact !== null);
    if (kept.length > 0) groups.push({ title, facts: kept });
  };

  add('Site', [
    text('Name', configString(config, 'site', 'name')),
    text('Timezone', configString(config, 'site', 'timezone') ?? 'System default'),
  ]);

  add('Camera', [
    onOff('Enabled', configBool(config, 'camera', 'enabled')),
    text('Source', configString(config, 'camera', 'source')),
    resolution(config),
    text('RTSP URL', configString(config, 'camera', 'rtsp_url'), true),
  ]);

  add('Audio', [
    onOff('Enabled', configBool(config, 'audio', 'enabled')),
    text('Device', configString(config, 'audio', 'device'), true),
    text('Sample rate', hz(configNumber(config, 'audio', 'sample_rate'))),
  ]);

  add('Environment', [
    onOff('Sensor', configBool(config, 'environment', 'enabled')),
    band(
      'Comfortable temperature',
      configNumber(config, 'environment', 'comfort', 'temp_c_min'),
      configNumber(config, 'environment', 'comfort', 'temp_c_max'),
      ' °C',
    ),
    band(
      'Comfortable humidity',
      configNumber(config, 'environment', 'comfort', 'humidity_min'),
      configNumber(config, 'environment', 'comfort', 'humidity_max'),
      '%',
    ),
  ]);

  add('Sleep detection', [
    text('Sample interval', seconds(configNumber(config, 'sleep', 'sample_interval_s'))),
    text('Day boundary', hour(configNumber(config, 'children', 'day_boundary_hour'))),
  ]);

  add('Analytics', [
    text('Default metric', configString(config, 'analytics', 'default_metric')),
    text('Default window', days(configNumber(config, 'analytics', 'default_window_days'))),
    text('Nights needed per tag', count(configNumber(config, 'analytics', 'min_nights_per_group'))),
    text('Nights needed in total', count(configNumber(config, 'analytics', 'min_nights_total'))),
    text('False discovery rate', numberText(configNumber(config, 'analytics', 'fdr_q'))),
  ]);

  add('API', [
    onOff('Password required', configBool(config, 'api', 'auth', 'enabled')),
    onOff('Tags created on the fly', configBool(config, 'api', 'notes', 'autocreate_tags')),
    text('Heartbeat', seconds(configNumber(config, 'api', 'sse_heartbeat_s'))),
  ]);

  add('HomeKit', [
    onOff('Enabled', configBool(config, 'homekit', 'enabled')),
    text('Accessory name', configString(config, 'homekit', 'name')),
    text('Port', count(configNumber(config, 'homekit', 'port'))),
  ]);

  add('Storage', [
    text('Data directory', configString(config, 'paths', 'data_dir'), true),
    text('Database', configString(config, 'paths', 'db'), true),
    text('Media', configString(config, 'paths', 'media_dir'), true),
    text('Samples kept', days(configNumber(config, 'retention', 'samples_days'))),
    text('Media kept', days(configNumber(config, 'retention', 'media_days'))),
  ]);

  return groups;
}

// -- Small formatters, each returning null when there is nothing to show ----

function text(label: string, value: string | null, mono = false): Fact | null {
  return value === null ? null : { label, value, mono };
}

function onOff(label: string, value: boolean | null): Fact | null {
  return value === null ? null : { label, value: value ? 'Yes' : 'No' };
}

function seconds(value: number | null): string | null {
  if (value === null) return null;
  return value < 60 ? `${value} s` : formatDuration(value / 60);
}

function days(value: number | null): string | null {
  if (value === null) return null;
  if (value === 0) return 'Kept forever';
  return `${value} days`;
}

function count(value: number | null): string | null {
  return value === null ? null : String(value);
}

function numberText(value: number | null): string | null {
  return value === null ? null : String(value);
}

function hz(value: number | null): string | null {
  return value === null ? null : `${value.toLocaleString()} Hz`;
}

function hour(value: number | null): string | null {
  return value === null ? null : `${String(value).padStart(2, '0')}:00`;
}

function resolution(config: Record<string, unknown>): Fact | null {
  const width = configNumber(config, 'camera', 'width');
  const height = configNumber(config, 'camera', 'height');
  const fps = configNumber(config, 'camera', 'fps');
  if (width === null || height === null) return null;
  return {
    label: 'Video',
    value: fps === null ? `${width}×${height}` : `${width}×${height} at ${fps} fps`,
  };
}

function band(label: string, low: number | null, high: number | null, unit: string): Fact | null {
  if (low === null && high === null) return null;
  if (low !== null && high !== null) return { label, value: `${low}${unit} – ${high}${unit}` };
  return { label, value: `${low ?? high}${unit}` };
}
