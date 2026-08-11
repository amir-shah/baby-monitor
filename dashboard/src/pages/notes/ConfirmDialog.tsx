import type { ReactNode } from 'react';
import { Button, Modal } from '../../components';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Destructive by default — the only thing this page confirms is deletion. */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation step, used only where an action cannot be undone.
 *
 * Archiving a tag is *not* one of those: it is reversible and keeps every
 * night it was ever applied to, so it happens on the first click with an undo
 * in the toast. Deleting a note is — the API soft-deletes it and offers no way
 * back — so it asks.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      size="sm"
      hideCloseButton
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            loadingLabel="Working"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{description}</p>
    </Modal>
  );
}
