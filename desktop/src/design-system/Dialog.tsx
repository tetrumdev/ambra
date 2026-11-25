import type { ComponentPropsWithRef } from "react";
import "./controls.css";

type DialogProps = Omit<ComponentPropsWithRef<"dialog">, "onCancel"> & {
  onDismiss: () => void;
};

export function Dialog({ className, onDismiss, ...props }: DialogProps) {
  return (
    <dialog
      {...props}
      className={className ? `uiDialog ${className}` : "uiDialog"}
      onCancel={event => {
        event.preventDefault();
        onDismiss();
      }}
    />
  );
}
