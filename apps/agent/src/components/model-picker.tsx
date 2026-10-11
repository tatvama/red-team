"use client";

import clsx from "clsx";
import { Check, ChevronDown, Cpu, RotateCcw } from "lucide-react";
import { type ModelConnection, type Provider, providerNames } from "@/lib/contract";
import type { ModelSelection } from "@/lib/client/agent-state";
import { onMenuKeyDown, usePopover } from "./use-popover";

export const providers: Provider[] = ["ollama", "gpu"];

const setupHints: Record<Provider, string> = {
  ollama: "Set OLLAMA_BASE_URL in .env.local",
  gpu: "Set GPU_BASE_URL and GPU_API_KEY in .env.local",
};

/** Short status for a provider connection. */
export function connectionStatus(connection: ModelConnection | null): string {
  if (!connection) return "Checking…";
  switch (connection.state) {
    case "ready":
      return connection.models.length === 1 ? "1 model" : `${connection.models.length} models`;
    case "offline":
      return "Server not reachable";
    case "unconfigured":
      return "Not configured";
    case "empty":
      return "No models installed";
  }
}

/** Status with a setup hint when the provider is not configured. */
export function connectionMessage(provider: Provider, connection: ModelConnection | null): string {
  return connection?.state === "unconfigured" ? setupHints[provider] : connectionStatus(connection);
}

export function ConnectionDot({ connection }: { connection: ModelConnection | null }) {
  return <span className={clsx("connection-dot", `connection-dot--${connection?.state ?? "checking"}`)} aria-hidden="true" />;
}

type ModelPickerProps = {
  connections: Record<Provider, ModelConnection | null>;
  selection: ModelSelection | null;
  onSelect: (selection: ModelSelection) => void;
  onRecheck: () => void;
};

export function ModelPicker({ connections, selection, onSelect, onRecheck }: ModelPickerProps) {
  const { open, setOpen, close, triggerRef, panelRef } = usePopover();
  const checking = providers.some((provider) => connections[provider] === null);

  return (
    <div className="picker">
      <button
        ref={triggerRef}
        type="button"
        className="picker__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={selection ? `Model: ${selection.model}. Change model` : "Choose a model"}
        onClick={() => setOpen(!open)}
      >
        <Cpu size={15} aria-hidden="true" />
        <span className="picker__value">{selection ? selection.model : checking ? "Checking models…" : "No model"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="popover popover--up model-menu"
          role="menu"
          aria-label="Models"
          onKeyDown={(event) => onMenuKeyDown(event, close)}
        >
          {providers.map((provider) => {
            const connection = connections[provider];
            return (
              <div key={provider} role="group" aria-labelledby={`provider-${provider}`} className="model-menu__group">
                <div id={`provider-${provider}`} className="model-menu__provider">
                  <ConnectionDot connection={connection} />
                  <span>{providerNames[provider]}</span>
                </div>
                {connection?.state === "ready" ? (
                  connection.models.map((model) => {
                    const checked = selection?.provider === provider && selection.model === model;
                    return (
                      <button
                        key={model}
                        type="button"
                        role="menuitemradio"
                        aria-checked={checked}
                        className="menu-item"
                        onClick={() => {
                          onSelect({ provider, model });
                          close();
                        }}
                      >
                        <span className="menu-item__label">{model}</span>
                        {checked && <Check size={15} aria-hidden="true" className="menu-item__check" />}
                      </button>
                    );
                  })
                ) : (
                  <p className="model-menu__hint">{connectionMessage(provider, connection)}</p>
                )}
              </div>
            );
          })}
          <div className="popover__footer">
            <button type="button" role="menuitem" className="menu-item menu-item--quiet" onClick={onRecheck}>
              <RotateCcw size={14} aria-hidden="true" />
              <span className="menu-item__label">Check connections again</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
