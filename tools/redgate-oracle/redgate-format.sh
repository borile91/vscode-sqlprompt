#!/usr/bin/env bash
# Oracolo: formatta file .sql con la CLI di Redgate SQL Prompt dentro una VM Parallels.
# Uso: redgate-format.sh -s stile.json -o cartella-uscita [-c] file.sql...
#   -c  applica anche il casing dello stile (--apply-casing)
# Variabili d'ambiente (con default per la VM di sviluppo):
#   ORACLE_VM          nome della VM Parallels           ("Windows 11")
#   ORACLE_HOST_ROOT   cartella condivisa lato Mac        (~/Development/_sqlprompt-re/oracle)
#   ORACLE_UNC_ROOT    stessa cartella vista dalla VM     (\\Mac\Development\_sqlprompt-re\oracle)
#   ORACLE_CLI         percorso della CLI nella VM
# Richiede l'accettazione della EULA Redgate (flag --i-agree-to-the-eula).
set -euo pipefail

VM="${ORACLE_VM:-Windows 11}"
HOST_ROOT="${ORACLE_HOST_ROOT:-$HOME/Development/_sqlprompt-re/oracle}"
UNC_ROOT="${ORACLE_UNC_ROOT:-\\\\Mac\\Development\\_sqlprompt-re\\oracle}"
CLI="${ORACLE_CLI:-C:\\Program Files (x86)\\Red Gate\\SQL Prompt 11\\SqlPrompt.Format.CommandLine.exe}"

style=""; out=""; casing=""
while getopts "s:o:c" opt; do
  case $opt in
    s) style="$OPTARG" ;;
    o) out="$OPTARG" ;;
    c) casing="--apply-casing" ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[[ -n "$style" && -n "$out" && $# -gt 0 ]] || { echo "uso: $0 -s stile.json -o uscita [-c] file.sql..." >&2; exit 2; }

run="run-$$-$(date +%s)"
stage="$HOST_ROOT/$run"
mkdir -p "$stage/sql" "$out"
trap 'rm -rf "$stage"' EXIT

cp "$style" "$stage/style.json"
for f in "$@"; do cp "$f" "$stage/sql/"; done

# Script batch eseguito nella VM: le unità mappate non esistono nel contesto di prlctl, quindi percorsi UNC
printf '@echo off\r\n"%s" --i-agree-to-the-eula %s -p "%s\\%s\\sql" -s "%s\\%s\\style.json" > "%s\\%s\\log.txt" 2>&1\r\necho %%ERRORLEVEL%% > "%s\\%s\\exit.txt"\r\n' \
  "$CLI" "$casing" "$UNC_ROOT" "$run" "$UNC_ROOT" "$run" "$UNC_ROOT" "$run" "$UNC_ROOT" "$run" > "$stage/run.cmd"

prlctl exec "$VM" cmd /c "$UNC_ROOT\\$run\\run.cmd" >/dev/null

code=$(tr -d '\r\n ' < "$stage/exit.txt")
if [[ "$code" != "0" ]]; then
  cat "$stage/log.txt" >&2
  exit 1
fi
# La CLI esce con 0 anche quando non trova lo stile: l'errore va letto dal log
if grep -q "Error encountered" "$stage/log.txt"; then
  cat "$stage/log.txt" >&2
  exit 1
fi
# File non parsabili: la CLI li lascia invariati e lo segnala nel log
grep -i -E "fail|skip|could not" "$stage/log.txt" >&2 || true
cp "$stage/sql/"*.sql "$out/"
