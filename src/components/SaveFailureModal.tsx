import { AlertTriangle, Download, RotateCcw, X } from "lucide-react";

export function SaveFailureModal({
  error,
  retrying,
  storageLabel,
  onRetry,
  onDownload,
  onDismiss,
}: {
  error: string;
  retrying: boolean;
  storageLabel: string;
  onRetry: () => void;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="save-failure-backdrop">
      <section
        className="save-failure-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-failure-title"
        aria-describedby="save-failure-description"
      >
        <header>
          <div className="save-failure-modal__icon" aria-hidden="true">
            <AlertTriangle size={20} />
          </div>
          <div>
            <span>Save failure</span>
            <h2 id="save-failure-title">Your latest changes were not saved</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss save failure warning"
            title="Dismiss warning"
            onClick={onDismiss}
          >
            <X size={17} />
          </button>
        </header>

        <p id="save-failure-description">
          Keep this tab open. Your current work is still in this page&apos;s memory, but it is not
          safely stored {storageLabel}.
        </p>

        <div className="save-failure-modal__error" role="status">
          <strong>Reported error</strong>
          <code>{error}</code>
        </div>

        <p className="save-failure-modal__note">
          Downloading a recovery file now is the safest option. Dismissing this warning does not
          mean the workspace has been saved; the status light will remain red.
        </p>

        <footer>
          <button className="secondary-button" type="button" onClick={onDownload}>
            <Download size={14} />
            Download unsaved backup
          </button>
          <button className="primary-button" type="button" disabled={retrying} onClick={onRetry}>
            <RotateCcw className={retrying ? "spin" : ""} size={14} />
            {retrying ? "Retrying…" : "Retry save"}
          </button>
        </footer>
      </section>
    </div>
  );
}
