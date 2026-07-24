import {
  Archive,
  ChevronLeft,
  Clock3,
  CopyPlus,
  Download,
  HardDrive,
  RotateCcw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import type { ChatTree } from "../types";
import type { RecoveryRecord } from "../lib/recovery";

function recoveryDescription(record: RecoveryRecord): string {
  const chats = record.workspace.chats.length;
  const categories = record.workspace.categories.length;
  return `${chats} ${chats === 1 ? "study" : "studies"} · ${categories} ${
    categories === 1 ? "category" : "categories"
  }`;
}

export function RecoveryFoundModal({
  record,
  onRestore,
  onDownload,
  onDiscard,
}: {
  record: RecoveryRecord;
  onRestore: () => void;
  onDownload: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="save-failure-backdrop">
      <section className="save-failure-modal recovery-found-modal" role="alertdialog" aria-modal="true">
        <header>
          <div className="save-failure-modal__icon"><HardDrive size={20} /></div>
          <div>
            <span>Recovery journal</span>
            <h2>Unsaved work was found in this browser</h2>
          </div>
        </header>
        <p>
          Locus recorded a browser-side safety copy at{" "}
          <strong>{new Date(record.updatedAt).toLocaleString()}</strong>. It may contain changes
          that did not reach the server or local data file.
        </p>
        <div className="recovery-found-modal__summary">
          <Archive size={16} />
          <span>{recoveryDescription(record)}</span>
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={onDiscard}>
            <Trash2 size={14} /> Discard copy
          </button>
          <button className="secondary-button" type="button" onClick={onDownload}>
            <Download size={14} /> Download
          </button>
          <button className="primary-button" type="button" onClick={onRestore}>
            <RotateCcw size={14} /> Restore unsaved work
          </button>
        </footer>
      </section>
    </div>
  );
}

export function RecoveryCenterModal({
  records,
  onBack,
  onClose,
  onCreate,
  onRestore,
  onDownload,
  onDelete,
}: {
  records: RecoveryRecord[];
  onBack: () => void;
  onClose: () => void;
  onCreate: () => void;
  onRestore: (record: RecoveryRecord) => void;
  onDownload: (record: RecoveryRecord) => void;
  onDelete: (record: RecoveryRecord) => void;
}) {
  return (
    <div className="settings-modal-backdrop">
      <section className="settings-modal recovery-center-modal" role="dialog" aria-modal="true">
        <header>
          <button className="settings-back-button" type="button" aria-label="Back to settings" onClick={onBack}>
            <ChevronLeft size={17} />
          </button>
          <div>
            <span>Data safety</span>
            <h2>Recovery history</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close recovery history" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="recovery-center-modal__body">
          <div className="recovery-center-modal__intro">
            <div>
              <h3>Browser-side safety journal</h3>
              <p>
                Unsaved changes are journaled automatically. Saved and failure snapshots provide
                a short local revision history on this device.
              </p>
            </div>
            <button type="button" onClick={onCreate}>
              <Archive size={14} /> Snapshot now
            </button>
          </div>
          {records.length ? (
            <ul className="recovery-record-list">
              {records.map((record) => (
                <li key={record.id}>
                  <Clock3 size={16} />
                  <div>
                    <strong>
                      {record.kind === "draft"
                        ? "Unsaved working copy"
                        : record.reason === "failure"
                          ? "Save-failure snapshot"
                          : record.reason === "manual"
                            ? "Manual snapshot"
                            : "Saved snapshot"}
                    </strong>
                    <span>{new Date(record.updatedAt).toLocaleString()}</span>
                    <small>{recoveryDescription(record)}</small>
                  </div>
                  <div>
                    <button type="button" onClick={() => onDownload(record)} title="Download snapshot">
                      <Download size={13} />
                    </button>
                    <button type="button" onClick={() => onRestore(record)} title="Restore snapshot">
                      <RotateCcw size={13} />
                    </button>
                    <button type="button" onClick={() => onDelete(record)} title="Delete snapshot">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="study-tools-empty">
              <HardDrive size={24} />
              <strong>No recovery snapshots on this device</strong>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function WorkspaceConflictModal({
  localChat,
  serverChat,
  onKeepLocal,
  onUseServer,
  onKeepBoth,
  onDownload,
}: {
  localChat: ChatTree;
  serverChat: ChatTree | null;
  onKeepLocal: () => void;
  onUseServer: () => void;
  onKeepBoth: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="save-failure-backdrop">
      <section className="save-failure-modal workspace-conflict-modal" role="alertdialog" aria-modal="true">
        <header>
          <div className="save-failure-modal__icon"><Server size={20} /></div>
          <div>
            <span>Save conflict</span>
            <h2>This study changed somewhere else</h2>
          </div>
        </header>
        <p>
          Choose deliberately which version should keep the original study ID. Nothing will be
          overwritten until you select an option.
        </p>
        <div className="workspace-conflict-versions">
          <section>
            <span>This tab</span>
            <strong>{localChat.title}</strong>
            <small>Updated {new Date(localChat.updatedAt).toLocaleString()}</small>
          </section>
          <section>
            <span>Saved version</span>
            <strong>{serverChat?.title ?? "Deleted elsewhere"}</strong>
            <small>
              {serverChat
                ? `Updated ${new Date(serverChat.updatedAt).toLocaleString()}`
                : "No longer present in storage"}
            </small>
          </section>
        </div>
        <button className="workspace-conflict-download" type="button" onClick={onDownload}>
          <Download size={14} /> Download this tab as a recovery file first
        </button>
        <footer>
          <button className="secondary-button" type="button" onClick={onUseServer}>
            <Server size={14} /> Use saved version
          </button>
          <button className="secondary-button" type="button" onClick={onKeepBoth}>
            <CopyPlus size={14} /> Keep both
          </button>
          <button className="primary-button" type="button" onClick={onKeepLocal}>
            <HardDrive size={14} /> Keep this tab
          </button>
        </footer>
      </section>
    </div>
  );
}
