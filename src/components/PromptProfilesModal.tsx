import {
  ChevronLeft,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  PromptProfile,
  PromptProfilePurpose,
  ProviderConnectionSummary,
  WorkspaceState,
} from "../types";
import { applyMarkdownShortcut } from "../lib/textarea";

const PURPOSES: Array<{
  id: PromptProfilePurpose;
  label: string;
  description: string;
}> = [
  { id: "chat", label: "Chat and branches", description: "Ordinary responses and elaboration branches" },
  { id: "definition", label: "Definitions", description: "Short definition popovers" },
  { id: "visualization", label: "Visualizations", description: "MetaPost and TikZ figure generation" },
  { id: "rewrite", label: "Rewrites", description: "Source and model-output rewriting" },
  { id: "inline-elaboration", label: "Inline elaboration", description: "Short explanations inside a message" },
];

function providerForPurpose(
  settings: WorkspaceState["settings"],
  purpose: PromptProfilePurpose,
): string {
  if (purpose === "definition") return settings.definitionProvider;
  if (purpose === "visualization") return settings.visualizationProvider;
  if (purpose === "rewrite") return settings.rewriteProvider;
  return settings.provider;
}

export function PromptProfilesModal({
  settings,
  providers,
  onChange,
  onBack,
  onClose,
}: {
  settings: WorkspaceState["settings"];
  providers: ProviderConnectionSummary[];
  onChange: (settings: WorkspaceState["settings"]) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(settings.promptProfiles[0]?.id ?? null);
  const selected = settings.promptProfiles.find((profile) => profile.id === selectedId) ?? null;

  const addProfile = () => {
    const now = new Date().toISOString();
    const profile: PromptProfile = {
      id: crypto.randomUUID(),
      name: "New profile",
      instructions: "",
      createdAt: now,
      updatedAt: now,
    };
    onChange({
      ...settings,
      promptProfiles: [...settings.promptProfiles, profile],
    });
    setSelectedId(profile.id);
  };

  const updateProfile = (update: Partial<Pick<PromptProfile, "name" | "instructions">>) => {
    if (!selected) return;
    onChange({
      ...settings,
      promptProfiles: settings.promptProfiles.map((profile) =>
        profile.id === selected.id
          ? { ...profile, ...update, updatedAt: new Date().toISOString() }
          : profile,
      ),
    });
  };

  const deleteProfile = () => {
    if (!selected || !window.confirm(`Delete prompt profile “${selected.name}”?`)) return;
    const assignments = Object.fromEntries(
      Object.entries(settings.promptProfileAssignments).map(([purpose, byProvider]) => [
        purpose,
        Object.fromEntries(
          Object.entries(byProvider ?? {}).filter(([, profileId]) => profileId !== selected.id),
        ),
      ]),
    );
    const remaining = settings.promptProfiles.filter((profile) => profile.id !== selected.id);
    onChange({
      ...settings,
      promptProfiles: remaining,
      promptProfileAssignments: assignments,
    });
    setSelectedId(remaining[0]?.id ?? null);
  };

  const assign = (
    purpose: PromptProfilePurpose,
    providerRef: string,
    profileId: string,
  ) => {
    const current = settings.promptProfileAssignments[purpose] ?? {};
    const next = { ...current };
    if (profileId) next[providerRef] = profileId;
    else delete next[providerRef];
    onChange({
      ...settings,
      promptProfileAssignments: {
        ...settings.promptProfileAssignments,
        [purpose]: next,
      },
    });
  };

  return (
    <div className="settings-modal-backdrop">
      <section
        className="settings-modal prompt-profiles-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-profiles-title"
      >
        <header>
          <button className="settings-back-button" type="button" aria-label="Back to settings" onClick={onBack}>
            <ChevronLeft size={17} />
          </button>
          <div>
            <span>Behavior</span>
            <h2 id="prompt-profiles-title">Prompt profiles</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close prompt profiles" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="prompt-profiles-layout">
          <aside className="prompt-profile-list">
            <header>
              <strong>Profiles</strong>
              <button type="button" aria-label="Create prompt profile" onClick={addProfile}>
                <Plus size={13} /> New
              </button>
            </header>
            {settings.promptProfiles.length ? (
              settings.promptProfiles.map((profile) => (
                <button
                  type="button"
                  className={profile.id === selectedId ? "active" : ""}
                  key={profile.id}
                  onClick={() => setSelectedId(profile.id)}
                >
                  <SlidersHorizontal size={13} />
                  <span>
                    <strong>{profile.name}</strong>
                    <small>{profile.instructions.length} characters</small>
                  </span>
                </button>
              ))
            ) : (
              <p>Create reusable behavior instructions, then route them to individual features.</p>
            )}
          </aside>

          <div className="prompt-profile-editor">
            {selected ? (
              <section>
                <header>
                  <div>
                    <span>Profile</span>
                    <input
                      aria-label="Prompt profile name"
                      value={selected.name}
                      maxLength={120}
                      onChange={(event) => updateProfile({ name: event.target.value })}
                    />
                  </div>
                  <button type="button" className="danger" onClick={deleteProfile}>
                    <Trash2 size={13} /> Delete
                  </button>
                </header>
                <label>
                  <span>Additional behavior instructions</span>
                  <textarea
                    value={selected.instructions}
                    rows={12}
                    maxLength={24_000}
                    placeholder="For example: Prefer geometric intuition, but keep every algebraic step explicit."
                    onChange={(event) => updateProfile({ instructions: event.target.value })}
                    onKeyDown={(event) =>
                      applyMarkdownShortcut(
                        event,
                        selected.instructions,
                        (instructions: string) => updateProfile({ instructions }),
                      )
                    }
                  />
                </label>
                <p>
                  This is appended to the built-in system prompt and your global custom instructions;
                  it does not replace either one.
                </p>
              </section>
            ) : (
              <div className="study-tools-empty">
                <SlidersHorizontal size={24} />
                <strong>Create a profile to begin</strong>
              </div>
            )}

            <section className="prompt-profile-routing">
              <header>
                <h3>Feature routing</h3>
                <p>Assignments are remembered separately for each active provider connection.</p>
              </header>
              <div>
                {PURPOSES.map((purpose) => {
                  const providerRef = providerForPurpose(settings, purpose.id);
                  const provider =
                    providers.find((candidate) => candidate.id === providerRef)?.label ??
                    providerRef;
                  return (
                    <label key={purpose.id}>
                      <span>
                        <strong>{purpose.label}</strong>
                        <small>{purpose.description} · {provider}</small>
                      </span>
                      <select
                        aria-label={`Prompt profile for ${purpose.label} with ${provider}`}
                        value={
                          settings.promptProfileAssignments[purpose.id]?.[providerRef] ?? ""
                        }
                        onChange={(event) =>
                          assign(purpose.id, providerRef, event.target.value)
                        }
                      >
                        <option value="">No profile</option>
                        {settings.promptProfiles.map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
