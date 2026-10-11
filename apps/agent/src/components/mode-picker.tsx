"use client";

import clsx from "clsx";
import { Check, ChevronDown, Compass, FilePen, Hand, type LucideIcon, Zap } from "lucide-react";
import { type PermissionMode, permissionModes } from "@/lib/contract";
import { onMenuKeyDown, usePopover } from "./use-popover";

const modeIcons: Record<PermissionMode, LucideIcon> = {
  ask: Hand,
  accept_edits: FilePen,
  plan: Compass,
  full_auto: Zap,
};

const modeOrder: PermissionMode[] = ["ask", "accept_edits", "plan", "full_auto"];

type ModePickerProps = { mode: PermissionMode; onChange: (mode: PermissionMode) => void };

export function ModePicker({ mode, onChange }: ModePickerProps) {
  const { open, setOpen, close, triggerRef, panelRef } = usePopover();
  const Icon = modeIcons[mode];

  return (
    <div className="picker">
      <button
        ref={triggerRef}
        type="button"
        className={clsx("picker__trigger", `mode--${mode}`)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${permissionModes[mode].label}. Change mode`}
        onClick={() => setOpen(!open)}
      >
        <Icon size={15} aria-hidden="true" />
        <span className="picker__value">{permissionModes[mode].label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="popover popover--up mode-menu"
          role="menu"
          aria-label="Permission mode"
          onKeyDown={(event) => onMenuKeyDown(event, close)}
        >
          {modeOrder.map((option) => {
            const OptionIcon = modeIcons[option];
            const checked = option === mode;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={clsx("menu-item menu-item--rich", `mode--${option}`)}
                onClick={() => {
                  onChange(option);
                  close();
                }}
              >
                <span className="mode-menu__icon">
                  <OptionIcon size={16} aria-hidden="true" />
                </span>
                <span className="menu-item__stack">
                  <span className="menu-item__label">{permissionModes[option].label}</span>
                  <span className="menu-item__description">{permissionModes[option].description}</span>
                </span>
                {checked && <Check size={15} aria-hidden="true" className="menu-item__check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
