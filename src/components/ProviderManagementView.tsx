import {
  Check,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  compatibleReasoningEffort,
} from "../lib/providers";
import type {
  ProviderConnectionSummary,
  ProviderModelOption,
  ProviderRef,
  ReasoningEffort,
  WorkspaceState,
} from "../types";
import { MODEL_OPTIONS, REASONING_OPTIONS } from "./ModelPicker";

type Settings = WorkspaceState["settings"];
type Feature = "chat" | "definition" | "visualization" | "rewrite";

const FEATURE_LABELS: Record<Feature, { label: string; note: string }> = {
  chat: { label: "Chat", note: "Main threads, elaborations, edits, and regenerations" },
  definition: { label: "Define", note: "Short inline definitions" },
  visualization: { label: "Visualize", note: "MetaPost and TikZ source generation" },
  rewrite: { label: "Rewrite", note: "Model-assisted source rewrites" },
};

function featureProvider(settings: Settings, feature: Feature): ProviderRef {
  if (feature === "chat") return settings.provider;
  if (feature === "definition") return settings.definitionProvider;
  if (feature === "visualization") return settings.visualizationProvider;
  return settings.rewriteProvider;
}

function featureModel(settings: Settings, feature: Feature, provider: ProviderRef): string {
  if (feature === "chat") {
    return settings.providerModels[provider] ??
      (provider === settings.provider ? settings.model : "");
  }
  if (feature === "definition") return settings.definitionModels[provider] ?? "";
  if (feature === "visualization") return settings.visualizationModels[provider] ?? "";
  return settings.rewriteModels[provider] ?? "";
}

function featureEffort(settings: Settings, feature: Feature, provider: ProviderRef): ReasoningEffort {
  if (feature === "chat") return settings.reasoningEffort;
  if (feature === "definition") return settings.definitionReasoningEfforts[provider] || "medium";
  if (feature === "visualization") return settings.visualizationReasoningEfforts[provider] || "high";
  return settings.rewriteReasoningEfforts[provider] || "high";
}

export function ProviderManagementView({
  mode,
  connections,
  settings,
  onConnectionsChange,
  updateSettings,
  onBack,
  onClose,
}: {
  mode: "local" | "hosted";
  connections: ProviderConnectionSummary[];
  settings: Settings;
  onConnectionsChange: (connections: ProviderConnectionSummary[]) => void;
  updateSettings: (update: (settings: Settings) => Settings) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelOption[]>>({});
  const [catalogLoading, setCatalogLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyProviderId, setKeyProviderId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [customEditor, setCustomEditor] = useState<{
    id: string | null;
    label: string;
    baseUrl: string;
    apiKey: string;
  } | null>(null);

  const connectionMap = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );

  const refresh = async () => {
    const response = await fetch("/api/provider-connections", { cache: "no-store" });
    const result = (await response.json().catch(() => ({}))) as {
      providers?: ProviderConnectionSummary[];
      error?: string;
    };
    if (!response.ok || !result.providers) throw new Error(result.error || "Could not load providers");
    onConnectionsChange(result.providers);
  };

  const loadCatalog = async (providerId: string) => {
    const connection = connectionMap.get(providerId);
    if (!connection || connection.kind === "openai" || catalogLoading[providerId]) return;
    setCatalogLoading((current) => ({ ...current, [providerId]: true }));
    try {
      const response = await fetch(`/api/provider-connections/${encodeURIComponent(providerId)}/models`);
      const result = (await response.json().catch(() => ({}))) as { models?: ProviderModelOption[] };
      if (!response.ok || !result.models) throw new Error();
      setCatalogs((current) => ({ ...current, [providerId]: result.models! }));
    } catch {
      setCatalogs((current) => ({ ...current, [providerId]: [] }));
    } finally {
      setCatalogLoading((current) => ({ ...current, [providerId]: false }));
    }
  };

  useEffect(() => {
    const selected = new Set<ProviderRef>([
      settings.provider,
      settings.definitionProvider,
      settings.visualizationProvider,
      settings.rewriteProvider,
    ]);
    selected.forEach((providerId) => {
      if (!(providerId in catalogs)) void loadCatalog(providerId);
    });
  }, [connections, settings.provider, settings.definitionProvider, settings.visualizationProvider, settings.rewriteProvider]);

  const setFeatureProvider = (feature: Feature, providerId: string) => {
    const connection = connectionMap.get(providerId);
    if (!connection) return;
    updateSettings((current) => {
      const model = featureModel(current, feature, providerId);
      if (feature === "chat") {
        return {
          ...current,
          provider: providerId,
          model,
          providerModels: { ...current.providerModels, [providerId]: model },
          reasoningEffort: compatibleReasoningEffort(connection.kind, model, current.reasoningEffort),
        };
      }
      if (feature === "definition") {
        return {
          ...current,
          definitionProvider: providerId,
          definitionModels: { ...current.definitionModels, [providerId]: model },
        };
      }
      if (feature === "visualization") {
        return {
          ...current,
          visualizationProvider: providerId,
          visualizationModels: { ...current.visualizationModels, [providerId]: model },
        };
      }
      return {
        ...current,
        rewriteProvider: providerId,
        rewriteModels: { ...current.rewriteModels, [providerId]: model },
      };
    });
    void loadCatalog(providerId);
  };

  const setFeatureModel = (feature: Feature, model: string) => {
    updateSettings((current) => {
      const providerId = featureProvider(current, feature);
      const connection = connectionMap.get(providerId);
      if (feature === "chat") {
        return {
          ...current,
          model,
          providerModels: { ...current.providerModels, [providerId]: model },
          reasoningEffort: connection
            ? compatibleReasoningEffort(connection.kind, model, current.reasoningEffort)
            : current.reasoningEffort,
        };
      }
      const key = feature === "definition" ? "definitionModels" : feature === "visualization" ? "visualizationModels" : "rewriteModels";
      return { ...current, [key]: { ...current[key], [providerId]: model } };
    });
  };

  const setFeatureEffort = (feature: Feature, effort: ReasoningEffort) => {
    updateSettings((current) => {
      const providerId = featureProvider(current, feature);
      if (feature === "chat") return { ...current, reasoningEffort: effort };
      const key = feature === "definition"
        ? "definitionReasoningEfforts"
        : feature === "visualization"
          ? "visualizationReasoningEfforts"
          : "rewriteReasoningEfforts";
      return { ...current, [key]: { ...current[key], [providerId]: effort } };
    });
  };

  const saveBuiltInKey = async () => {
    if (!keyProviderId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(keyProviderId)}/api-key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: keyDraft }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save the API key");
      await refresh();
      setKeyProviderId(null);
      setKeyDraft("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the API key");
    } finally {
      setBusy(false);
    }
  };

  const clearBuiltInKey = async (providerId: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/api-key`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not clear the saved API key");
      await refresh();
      setKeyProviderId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not clear the saved API key");
    } finally {
      setBusy(false);
    }
  };

  const saveCustom = async () => {
    if (!customEditor) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        customEditor.id
          ? `/api/provider-connections/${encodeURIComponent(customEditor.id)}`
          : "/api/provider-connections",
        {
          method: customEditor.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: customEditor.label,
            baseUrl: customEditor.baseUrl,
            ...(customEditor.apiKey ? { apiKey: customEditor.apiKey } : {}),
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not save the custom provider");
      await refresh();
      setCustomEditor(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the custom provider");
    } finally {
      setBusy(false);
    }
  };

  const deleteCustom = async (provider: ProviderConnectionSummary) => {
    if (!window.confirm(`Delete ${provider.label}? Existing chats remain, but routes using it will switch to OpenAI.`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/provider-connections/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete the custom provider");
      updateSettings((current) => ({
        ...current,
        provider: current.provider === provider.id ? "openai" : current.provider,
        model: current.provider === provider.id ? current.providerModels.openai : current.model,
        definitionProvider: current.definitionProvider === provider.id ? "openai" : current.definitionProvider,
        visualizationProvider: current.visualizationProvider === provider.id ? "openai" : current.visualizationProvider,
        rewriteProvider: current.rewriteProvider === provider.id ? "openai" : current.rewriteProvider,
      }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the custom provider");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-modal settings-modal--providers" role="dialog" aria-modal="true" aria-labelledby="provider-settings-title">
        <header>
          <button className="settings-back-button" type="button" aria-label="Back to settings" title="Back to settings" onClick={onBack}><ChevronLeft size={17} /></button>
          <div><span>Model access</span><h2 id="provider-settings-title">Providers</h2></div>
          <button className="icon-button" type="button" aria-label="Close providers" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="provider-view">
          <section className="provider-view__section">
            <header><h3>Feature routing</h3><p>Each feature can use a different provider, model, and reasoning effort.</p></header>
            <div className="provider-routes">
              {(Object.keys(FEATURE_LABELS) as Feature[]).map((feature) => {
                const providerId = featureProvider(settings, feature);
                const connection = connectionMap.get(providerId) ?? connections[0];
                if (!connection) return null;
                const model = featureModel(settings, feature, providerId);
                const models = catalogs[providerId] ?? [];
                return (
                  <article className="provider-route" key={feature}>
                    <header><strong>{FEATURE_LABELS[feature].label}</strong><small>{FEATURE_LABELS[feature].note}</small></header>
                    <div className="provider-route__controls">
                      <select aria-label={`${FEATURE_LABELS[feature].label} provider`} value={providerId} onChange={(event) => setFeatureProvider(feature, event.target.value)}>
                        {connections.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}{candidate.configured || candidate.kind === "custom" ? "" : " · key needed"}</option>)}
                      </select>
                      {connection.kind === "openai" ? (
                        <select aria-label={`${FEATURE_LABELS[feature].label} model`} value={model} onChange={(event) => setFeatureModel(feature, event.target.value)}>
                          {MODEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      ) : (
                        <><input aria-label={`${FEATURE_LABELS[feature].label} model`} value={model} list={`provider-models-${feature}`} onChange={(event) => setFeatureModel(feature, event.target.value)} placeholder="Model ID" spellCheck={false} /><datalist id={`provider-models-${feature}`}>{models.map((option) => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}</datalist></>
                      )}
                      <select aria-label={`${FEATURE_LABELS[feature].label} reasoning effort`} value={featureEffort(settings, feature, providerId)} onChange={(event) => setFeatureEffort(feature, event.target.value as ReasoningEffort)}>
                        {REASONING_OPTIONS.map((option) => <option key={option.value} value={option.value} disabled={option.value === "max" && connection.kind === "openai" && !model.startsWith("gpt-5.6")}>{option.label} reasoning</option>)}
                      </select>
                      {catalogLoading[providerId] ? <LoaderCircle className="auth-screen__spinner" size={13} /> : connection.kind !== "openai" && <button type="button" className="provider-route__refresh" onClick={() => void loadCatalog(providerId)} title="Reload model IDs"><RefreshCw size={13} /></button>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="provider-view__section">
            <header><h3>Connections</h3><p>Keys stay server-side. Multiple connections can be active through the routes above.</p></header>
            <div className="provider-connections">
              {connections.map((provider) => (
                <article className="provider-connection" key={provider.id}>
                  <ServerCog size={16} />
                  <span><strong>{provider.label}</strong><small>{provider.kind === "custom" ? provider.baseUrl : provider.note}</small></span>
                  <em data-configured={provider.configured || undefined}>{provider.configured ? provider.source === "managed" ? "Managed" : "Configured" : provider.required ? "Key needed" : "No key"}</em>
                  {provider.kind === "custom" ? <>
                    <button type="button" onClick={() => setCustomEditor({ id: provider.id, label: provider.label, baseUrl: provider.baseUrl || "", apiKey: "" })}><Pencil size={13} /> Edit</button>
                    <button type="button" className="provider-connection__danger" onClick={() => void deleteCustom(provider)}><Trash2 size={13} /></button>
                  </> : <button type="button" onClick={() => { setKeyProviderId(provider.id); setKeyDraft(""); setError(""); }}><KeyRound size={13} /> Configure</button>}
                </article>
              ))}
            </div>
            <button className="secondary-button provider-add-button" type="button" onClick={() => setCustomEditor({ id: null, label: "", baseUrl: mode === "local" ? "http://127.0.0.1:1234/v1" : "https://", apiKey: "" })}><Plus size={14} /> Add Custom OpenAI Compatible endpoint</button>
          </section>
          {error && <p className="api-key-error" role="alert">{error}</p>}
        </div>
      </section>

      {keyProviderId && connectionMap.get(keyProviderId) && (
        <div className="provider-editor" role="dialog" aria-modal="true" aria-label={`${connectionMap.get(keyProviderId)!.label} API key`}>
          <header><div><span>Credential</span><h3>{connectionMap.get(keyProviderId)!.label}</h3></div><button className="icon-button" type="button" onClick={() => setKeyProviderId(null)}><X size={15} /></button></header>
          <p>The key is stored privately and is never returned to the browser.</p>
          <input autoFocus type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder="API key" autoComplete="off" />
          <footer>
            {connectionMap.get(keyProviderId)!.source === "saved" && <button className="secondary-button" type="button" disabled={busy} onClick={() => void clearBuiltInKey(keyProviderId)}>Clear saved key</button>}
            <button className="secondary-button" type="button" onClick={() => setKeyProviderId(null)}>Cancel</button>
            <button className="primary-button" type="button" disabled={busy || keyDraft.trim().length < 1} onClick={() => void saveBuiltInKey()}>{busy ? "Saving…" : "Save key"}</button>
          </footer>
        </div>
      )}

      {customEditor && (
        <div className="provider-editor" role="dialog" aria-modal="true" aria-label="Custom OpenAI Compatible endpoint">
          <header><div><span>Connection</span><h3>Custom OpenAI Compatible</h3></div><button className="icon-button" type="button" onClick={() => setCustomEditor(null)}><X size={15} /></button></header>
          <label><span>Name</span><input autoFocus value={customEditor.label} maxLength={120} onChange={(event) => setCustomEditor({ ...customEditor, label: event.target.value })} placeholder="e.g. Local Qwen" /></label>
          <label><span>Base URL</span><input type="url" value={customEditor.baseUrl} onChange={(event) => setCustomEditor({ ...customEditor, baseUrl: event.target.value })} placeholder={mode === "hosted" ? "https://models.example.com/v1" : "http://127.0.0.1:1234/v1"} spellCheck={false} /></label>
          <label><span>API key <small>{customEditor.id ? "leave blank to keep existing" : "optional"}</small></span><input type="password" value={customEditor.apiKey} onChange={(event) => setCustomEditor({ ...customEditor, apiKey: event.target.value })} autoComplete="off" /></label>
          <p>{mode === "hosted" ? "Hosted endpoints must use HTTPS and resolve to public network addresses." : "Local mode accepts HTTP and HTTPS endpoints."}</p>
          <footer><button className="secondary-button" type="button" onClick={() => setCustomEditor(null)}>Cancel</button><button className="primary-button" type="button" disabled={busy || !customEditor.label.trim() || !customEditor.baseUrl.trim()} onClick={() => void saveCustom()}>{busy ? "Saving…" : <><Check size={13} /> Save connection</>}</button></footer>
        </div>
      )}
    </div>
  );
}
