"use client";

import clsx from "clsx";
import { Check, ChevronDown, Cpu, RotateCcw, Route } from "lucide-react";
import { type ModelConnection, type Provider, providerNames, type RouterConfig } from "@/lib/contract";
import { type ModelChoice, type ModelSelection, routerAvailable } from "@/lib/client/agent-state";
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
  selection: ModelChoice | ModelSelection | null;
  onSelect: (selection: ModelSelection) => void;
  onRecheck: () => void;
  /** The server's model router; "Auto (router)" is offered while it is enabled. */
  router?: RouterConfig | null;
  onSelectAuto?: () => void;
};

/** One line on what Auto does with the current router settings. */
export function routerSummary(router: RouterConfig): string {
  if (!router.main) return "The router has no main model.";
  const canary = router.canary
    ? ` ${router.canary.percent}% of new tasks try ${router.canary.model.model}.`
    : "";
  return `The server picks the model: ${router.main.model} by default.${canary}`;
}

export function ModelPicker({ connections, selection, onSelect, onRecheck, router = null, onSelectAuto }: ModelPickerProps) {
  const { open, setOpen, close, triggerRef, panelRef } = usePopover();
  const checking = providers.some((provider) => connections[provider] === null);
  const auto = selection !== null && "auto" in selection && selection.auto;
  const offerAuto = routerAvailable(router) && onSelectAuto !== undefined;
  const label = auto ? "Auto (router)" : selection?.model;

  return (
    <div className="picker">
      <button
        ref={triggerRef}
        type="button"
        className="picker__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ? `Model: ${label}. Change model` : "Choose a model"}
        title={auto && router ? routerSummary(router) : undefined}
        onClick={() => setOpen(!open)}
      >
        {auto ? <Route size={15} aria-hidden="true" /> : <Cpu size={15} aria-hidden="true" />}
        <span className="picker__value">{auto ? "Auto" : (label ?? (checking ? "Checking models…" : "No model"))}</span>
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
          {offerAuto && (
            <div role="group" aria-label="Router" className="model-menu__group">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={auto}
                className="menu-item menu-item--rich"
                onClick={() => {
                  onSelectAuto();
                  close();
                }}
              >
                <span className="model-menu__auto-icon">
                  <Route size={15} aria-hidden="true" />
                </span>
                <span className="menu-item__stack">
                  <span className="menu-item__label">Auto (router)</span>
                  <span className="menu-item__description">{routerSummary(router)}</span>
                </span>
                {auto && <Check size={15} aria-hidden="true" className="menu-item__check" />}
              </button>
            </div>
          )}
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
                    const checked = !auto && selection?.provider === provider && selection.model === model;
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
