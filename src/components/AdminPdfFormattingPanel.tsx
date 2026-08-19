import { Check, FileText, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminRequest } from "../lib/admin";
import { MODEL_OPTIONS } from "./ModelPicker";

interface PdfRepairSettings {
  model: string;
  fallbackModel: string;
  overridden: boolean;
}

export function AdminPdfFormattingPanel() {
  const [settings, setSettings] = useState<PdfRepairSettings | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await adminRequest<{ settings: PdfRepairSettings }>(
        "/api/admin/pdf-repair/settings",
      );
      setSettings(result.settings);
      setModel(result.settings.model);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load PDF formatting settings");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!model.trim()) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await adminRequest<{ settings: PdfRepairSettings }>(
        "/api/admin/pdf-repair/settings",
        { method: "PATCH", body: JSON.stringify({ model: model.trim() }) },
      );
      setSettings(result.settings);
      setModel(result.settings.model);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the formatter model");
    } finally {
      setBusy(false);
    }
  };

  const restoreDefault = async () => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await adminRequest<{ settings: PdfRepairSettings }>(
        "/api/admin/pdf-repair/settings",
        { method: "PATCH", body: JSON.stringify({ model: null }) },
      );
      setSettings(result.settings);
      setModel(result.settings.model);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore the deployment default");
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <div className="admin-account-empty">
        {busy ? (
          <><LoaderCircle className="auth-screen__spinner" size={17} /> Loading PDF formatting settings…</>
        ) : (
          <>
            <span role="alert">{error || "PDF formatting settings are unavailable."}</span>
            <button type="button" onClick={() => void load()}>Try again</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="admin-pdf-formatting">
      <section className="admin-access__section">
        <header>
          <span><FileText size={15} /><strong>Formatting model</strong></span>
          {saved && <small className="admin-pdf-formatting__saved"><Check size={12} /> Saved</small>}
        </header>
        <p>
          This OpenAI model repairs OCR Markdown structure, math delimiters, and page furniture
          after Mistral finishes OCR. New formatting requests use a saved change immediately.
        </p>
        <form className="admin-pdf-formatting__form" onSubmit={save}>
          <label>
            <span>OpenAI model ID</span>
            <input
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setSaved(false);
              }}
              list="admin-pdf-formatting-models"
              placeholder="gpt-5.4-mini"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              disabled={busy}
            />
            <datalist id="admin-pdf-formatting-models">
              {MODEL_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </datalist>
          </label>
          <button className="primary-button" type="submit" disabled={busy || !model.trim()}>
            {busy ? <LoaderCircle className="auth-screen__spinner" size={13} /> : <Check size={13} />}
            Save model
          </button>
          <button
            type="button"
            disabled={busy || !settings.overridden}
            onClick={() => void restoreDefault()}
          >
            <RotateCcw size={13} /> Use deployment default
          </button>
        </form>
        <small className="admin-pdf-formatting__status">
          Effective model: <code>{settings.model}</code>
          {settings.overridden
            ? <> · deployment fallback: <code>{settings.fallbackModel}</code></>
            : " · using the deployment default"}
        </small>
        <p>
          Changing to an unpriced model leaves cost entries unpriced and can prevent use of
          administrator-managed keys that have a USD limit.
        </p>
      </section>
      {error && <p className="admin-account-error" role="alert">{error}</p>}
    </div>
  );
}
