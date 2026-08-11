/**
 * Route stubs.
 *
 * Task 2 replaces each of these with the real page. They exist now so the
 * router, the shell, the nav highlighting and the responsive layout can be
 * built and checked end to end before any data arrives.
 */

import { useParams } from 'react-router-dom';
import { Card, EmptyState } from '../components';
import { nightHeading } from '../lib/format';

function Stub({ name, note }: { name: string; note?: string }) {
  return (
    <Card title={name}>
      <EmptyState
        title={`${name} page`}
        description={note ?? 'This page is scaffolded. Its contents land in the next pass.'}
        size="sm"
      />
    </Card>
  );
}

export function LivePage() {
  return (
    <Stub
      name="Live"
      note="Current state, camera preview, sound and motion, tonight so far."
    />
  );
}

export function NightPage() {
  const { date } = useParams<{ date: string }>();
  return (
    <Stub
      name={nightHeading(date)}
      note="Hypnogram, timeline, events and notes for this night."
    />
  );
}

export function NotesPage() {
  return <Stub name="Notes" note="Journal and tags, with the quick-add composer." />;
}

export function AnalyticsPage() {
  return (
    <Stub
      name="Analytics"
      note="Trends, the factor analysis, regularity and patterns."
    />
  );
}

export function EventsPage() {
  return <Stub name="Events" note="The event log, with filters and label correction." />;
}

export function SystemPage() {
  return <Stub name="System" note="Health, host info, config and the operational log." />;
}
