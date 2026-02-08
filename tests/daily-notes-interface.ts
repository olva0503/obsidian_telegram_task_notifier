import { TFile } from "obsidian";

export type DailyNoteSettings = {
  folder?: string;
  format?: string;
  template?: string;
};

let currentSettings: DailyNoteSettings | null = {
  folder: "",
  format: "YYYY-MM-DD"
};

type DailyNotesIndex = Record<string, TFile> | Map<string, TFile>;

const defaultGetAllDailyNotes = (): DailyNotesIndex => ({
  "2024-01-01": new TFile("2024-01-01.md")
});

let getAllDailyNotesImpl: () => DailyNotesIndex = defaultGetAllDailyNotes;

export const getDailyNoteSettings = (): DailyNoteSettings | null => currentSettings;

export const setDailyNoteSettings = (settings: DailyNoteSettings | null): void => {
  currentSettings = settings;
};

export const getAllDailyNotes = (): DailyNotesIndex => {
  return getAllDailyNotesImpl();
};

export const setGetAllDailyNotes = (
  fn: (() => DailyNotesIndex) | null
): void => {
  getAllDailyNotesImpl = fn ?? defaultGetAllDailyNotes;
};

export const createDailyNote = async (_date: unknown, settings: DailyNoteSettings): Promise<TFile> => {
  const folder = settings.folder ? `${settings.folder}/` : "";
  return new TFile(`${folder}2024-01-01.md`);
};
