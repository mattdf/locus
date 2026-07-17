import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import type { SendShortcut } from "../types";

type StringSetter = Dispatch<SetStateAction<string>> | ((value: string) => void);

export function applyMarkdownShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: StringSetter,
): boolean {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key !== "b" && key !== "i") return false;

  event.preventDefault();
  const textarea = event.currentTarget;
  const marker = key === "b" ? "**" : "*";
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selection = value.slice(start, end);
  let nextValue: string;
  let nextStart: number;
  let nextEnd: number;

  if (
    start >= marker.length &&
    value.slice(start - marker.length, start) === marker &&
    value.slice(end, end + marker.length) === marker
  ) {
    nextValue =
      value.slice(0, start - marker.length) +
      selection +
      value.slice(end + marker.length);
    nextStart = start - marker.length;
    nextEnd = end - marker.length;
  } else if (
    selection.length >= marker.length * 2 &&
    selection.startsWith(marker) &&
    selection.endsWith(marker)
  ) {
    const unwrapped = selection.slice(marker.length, -marker.length);
    nextValue = value.slice(0, start) + unwrapped + value.slice(end);
    nextStart = start;
    nextEnd = start + unwrapped.length;
  } else {
    nextValue =
      value.slice(0, start) + marker + selection + marker + value.slice(end);
    nextStart = start + marker.length;
    nextEnd = selection
      ? end + marker.length
      : start + marker.length;
  }

  setValue(nextValue);
  window.requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(nextStart, nextEnd);
  });
  return true;
}

export function isSendShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcut: SendShortcut,
): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return false;
  return shortcut === "mod-enter" ? event.metaKey || event.ctrlKey : true;
}

export function sendShortcutLabel(shortcut: SendShortcut): string {
  return shortcut === "mod-enter" ? "⌘/Ctrl Enter to send" : "Enter to send";
}
