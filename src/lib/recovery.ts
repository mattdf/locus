import type { WorkspaceState } from "../types";

const DATABASE_NAME = "locus-recovery";
const DATABASE_VERSION = 1;
const STORE_NAME = "workspace-snapshots";
const MAX_ARCHIVED_SNAPSHOTS = 12;

export interface RecoveryRecord {
  id: string;
  ownerKey: string;
  kind: "draft" | "archive";
  reason: "unsaved" | "saved" | "failure" | "manual";
  createdAt: string;
  updatedAt: string;
  workspace: WorkspaceState;
}

function indexedDbAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
  });
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (!indexedDbAvailable()) return null;
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(STORE_NAME)) return;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("ownerKindUpdated", ["ownerKey", "kind", "updatedAt"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the recovery journal"));
  });
}

function draftId(ownerKey: string): string {
  return `draft:${ownerKey}`;
}

export async function writeRecoveryDraft(
  ownerKey: string,
  workspace: WorkspaceState,
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const existing = await requestResult(
      database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(draftId(ownerKey)),
    ) as RecoveryRecord | undefined;
    const now = new Date().toISOString();
    const record: RecoveryRecord = {
      id: draftId(ownerKey),
      ownerKey,
      kind: "draft",
      reason: "unsaved",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      workspace,
    };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function readRecoveryDraft(
  ownerKey: string,
): Promise<RecoveryRecord | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    return (
      (await requestResult(
        database
          .transaction(STORE_NAME, "readonly")
          .objectStore(STORE_NAME)
          .get(draftId(ownerKey)),
      )) as RecoveryRecord | undefined
    ) ?? null;
  } finally {
    database.close();
  }
}

export async function clearRecoveryDraft(ownerKey: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(draftId(ownerKey));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function archiveRecoverySnapshot(
  ownerKey: string,
  workspace: WorkspaceState,
  reason: RecoveryRecord["reason"],
): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const now = new Date().toISOString();
    const record: RecoveryRecord = {
      id: `archive:${ownerKey}:${now}:${crypto.randomUUID()}`,
      ownerKey,
      kind: "archive",
      reason,
      createdAt: now,
      updatedAt: now,
      workspace,
    };
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const records = (await requestResult(
      readTransaction.objectStore(STORE_NAME).getAll(),
    )) as RecoveryRecord[];
    const older = records
      .filter((item) => item.ownerKey === ownerKey && item.kind === "archive")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(MAX_ARCHIVED_SNAPSHOTS - 1);

    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(record);
    older.forEach((item) => store.delete(item.id));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function listRecoverySnapshots(
  ownerKey: string,
): Promise<RecoveryRecord[]> {
  const database = await openDatabase();
  if (!database) return [];
  try {
    const records = (await requestResult(
      database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .getAll(),
    )) as RecoveryRecord[];
    return records
      .filter((item) => item.ownerKey === ownerKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } finally {
    database.close();
  }
}

export async function deleteRecoverySnapshot(id: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

