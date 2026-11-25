import type { ComponentPropsWithRef } from "react";

type IconButtonProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  icon: string;
  label: string;
};

export function IconButton({ icon, label, className, ...props }: IconButtonProps) {
  return (
    <button {...props} type="button" aria-label={label}
      className={className ? `uiIconButton uiIconButtonQuiet ${className}` : "uiIconButton uiIconButtonQuiet"}>
      <img src={icon} alt="" />
    </button>
  );
}
