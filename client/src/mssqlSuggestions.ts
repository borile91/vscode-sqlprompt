/**
 * Suggerimenti dell'estensione mssql: dove spegnerli (`sqlPrompt.suppressMssqlIntellisense`).
 *
 * VS Code non permette di spegnere i suggerimenti di un'altra estensione senza
 * scrivere un'impostazione. Le versioni precedenti scrivevano
 * `mssql.intelliSense.enableSuggestions` nel workspace a ogni connessione e lo
 * toglievano alla disconnessione, sporcando `.code-workspace` di continuo. Ora
 * la chiave si scrive **una volta** dove l'utente ha scelto e non si tocca più.
 *
 * Qui solo la decisione, senza dipendenze da VS Code, per poterla testare.
 */

export type SuppressMode = 'user' | 'workspace' | 'off';

/** Valore dell'impostazione, compresi i vecchi `true` / `false`. Default: `user`. */
export function normalizeMode(raw: unknown): SuppressMode {
  if (raw === false || raw === 'off') return 'off';
  if (raw === 'workspace') return 'workspace';
  return 'user';
}

/** Stato attuale di `mssql.intelliSense.enableSuggestions` e di chi l'ha scritto. */
export interface SuggestionsState {
  globalValue: unknown;
  workspaceValue: unknown;
  /** Il valore utente l'ha scritto SQL Prompt. */
  ownGlobal: boolean;
  /** Il valore di workspace l'ha scritto SQL Prompt. */
  ownWorkspace: boolean;
}

/** `false` = scrivi "spento", `null` = togli il valore, `undefined` = non toccare. */
export interface SuggestionsPlan {
  global?: false | null;
  workspace?: false | null;
}

export function planSuggestions(mode: SuppressMode, state: SuggestionsState): SuggestionsPlan {
  const plan: SuggestionsPlan = {};

  if (mode === 'user') {
    if (state.globalValue !== false) plan.global = false;
  } else if (state.ownGlobal && state.globalValue === false) {
    plan.global = null;
  }

  if (mode === 'workspace') {
    if (state.workspaceValue !== false) plan.workspace = false;
  } else if (state.workspaceValue === false) {
    // Nostro, oppure lasciato dalle versioni che lo scrivevano a ogni connessione.
    plan.workspace = null;
  }

  return plan;
}
