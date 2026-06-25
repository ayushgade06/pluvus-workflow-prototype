// ConfirmDialog — styled replacement for window.confirm. Same decision shape
// (resolve via onConfirm / onCancel); destructive variant tints the action.
import type { ReactNode } from "react";
import { colors, font } from "../../theme";
import { Modal } from "./Modal";
import { Button } from "./Button";

interface Props {
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            style={destructive ? { background: colors.danger, color: "#fff", borderColor: colors.danger } : undefined}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ padding: "18px 22px", fontSize: font.size.md, color: colors.textMuted, lineHeight: 1.6 }}>
        {message}
      </div>
    </Modal>
  );
}
