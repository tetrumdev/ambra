import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";
import { DropdownChevron } from "./DropdownChevron";
import "./controls.css";

export type DropdownOption<Value extends string> = { value: Value; label: string; icon?: string };

type DropdownProps<Value extends string> = {
  label: string;
  value: Value;
  options: readonly DropdownOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
  iconOnly?: boolean;
};

function positionMenu(trigger: HTMLButtonElement, menu: HTMLDivElement) {
  const gap = 6;
  const edge = 12;
  const bounds = trigger.getBoundingClientRect();
  menu.style.minWidth = `${Math.min(bounds.width, window.innerWidth - 2 * edge)}px`;
  const above = bounds.top - gap - edge;
  const below = window.innerHeight - bounds.bottom - gap - edge;
  const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
  const opensBelow = height <= below || below >= above;
  menu.style.maxHeight = `${Math.max(0, opensBelow ? below : above)}px`;
  menu.style.left = `${Math.max(edge, Math.min(bounds.right, window.innerWidth - edge) - menu.offsetWidth)}px`;
  menu.style.top = `${opensBelow ? bounds.bottom + gap : bounds.top - gap - menu.offsetHeight}px`;
  menu.style.transformOrigin = opensBelow ? "top right" : "bottom right";
}

function DropdownMenu({ menu, trigger, id, label, iconOnly, children }: {
  menu: RefObject<HTMLDivElement | null>;
  trigger: RefObject<HTMLButtonElement | null>;
  id: string;
  label: string;
  iconOnly?: boolean;
  children: ReactNode;
}) {
  useFadeOutOnUnmount(menu);
  useLayoutEffect(() => {
    const button = trigger.current;
    const popup = menu.current;
    if (!button || !popup) return;
    // Keep the dropdown above scrolling views and modal dialogs.
    popup.showPopover?.();
    const place = () => positionMenu(button, popup);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      if (popup.isConnected) popup.hidePopover?.();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menu, trigger]);
  return (
    <div ref={menu} id={id} popover="manual" className="dropdownMenu uiMenu uiMenuPopup" role="menu" aria-label={label}
      data-icon-only={iconOnly || undefined}>
      {children}
    </div>
  );
}

export function Dropdown<Value extends string>({ label, value, options, onChange, disabled = false, className, iconOnly }: DropdownProps<Value>) {
  const id = useId();
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const expanded = open && !disabled;
  const selected = options.find(option => option.value === value);
  const selectedLabel = selected?.label ?? "None";
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (expanded && trigger.current && menu.current) positionMenu(trigger.current, menu.current);
  });

  useLayoutEffect(() => {
    if (!expanded || !menu.current) return;
    const option = menu.current.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current.querySelector("button");
    option?.focus();
  }, [expanded, value]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!expanded) return;
    // WebKit can blur an option without focusing the trigger when the trigger is clicked.
    const dismissOutside = (event: Event) => {
      if (event.target && !control.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [expanded]);

  return (
    <div className={className ? `dropdown ${className}` : "dropdown"} ref={control}
      onKeyDown={event => {
        if (expanded && (event.key === "Escape" || event.key === "Tab")) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          close();
          return;
        }
        const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
        if (disabled || (!arrow && (!expanded || (event.key !== "Home" && event.key !== "End")))) return;
        event.preventDefault();
        event.stopPropagation();
        if (!expanded) {
          setOpen(true);
          return;
        }
        const items = Array.from(menu.current?.querySelectorAll("button") ?? []);
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : current < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0)
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <button ref={trigger} type="button" className="uiField dropdownTrigger" disabled={disabled}
        aria-label={`${label}: ${selectedLabel}`} aria-haspopup="menu" aria-expanded={expanded}
        aria-controls={expanded ? id : undefined} data-tooltip={iconOnly ? selectedLabel : undefined}
        onMouseDown={event => {
          if (expanded && event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          if (expanded) close();
          else setOpen(true);
        }}>
        {iconOnly && selected?.icon ? <img className="dropdownIcon" src={selected.icon} alt="" />
          : <><span className="dropdownValue">{selectedLabel}</span><DropdownChevron /></>}
      </button>
      {expanded && (
        <DropdownMenu menu={menu} trigger={trigger} id={id} label={label} iconOnly={iconOnly}>
          {options.map(option => (
            <button key={option.value} type="button" className="uiMenuOption" role="menuitemradio"
              aria-label={iconOnly ? option.label : undefined} data-tooltip={iconOnly ? option.label : undefined}
              aria-checked={value === option.value} tabIndex={-1} onClick={() => {
                close();
                if (value !== option.value) onChange(option.value);
              }}>
              {iconOnly ? <img className="dropdownIcon" src={option.icon} alt="" /> : <>
                <span className="uiMenuCheck" aria-hidden="true" />
                <span className="dropdownOptionLabel">{option.label}</span>
              </>}
            </button>
          ))}
        </DropdownMenu>
      )}
    </div>
  );
}
