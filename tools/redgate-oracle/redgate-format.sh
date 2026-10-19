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

# Parallels sospende la VM quando è inattiva: la si riprende prima di usarla
if prlctl list -a | grep -q "suspended .*$VM\|paused .*$VM"; then
  prlctl resume "$VM" >/dev/null
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  prlctl exec "$VM" cmd /c "echo ok" 2>/dev/null | grep -q ok && break
  sleep 3
done

run="run-$$-$(date +%s)"
stage="$HOST_ROOT/$run"
mkdir -p "$stage" "$out"
trap 'rm -rf "$stage"' EXIT
cp "$style" "$stage/style.json"

# A blocchi: una sessione prlctl exec troppo lunga viene interrotta (PRL_ERR_IO_STOPPED)
chunk="${ORACLE_CHUNK:-150}"
files=("$@")
for ((start = 0; start < ${#files[@]}; start += chunk)); do
  part="p$((start / chunk))"
  mkdir -p "$stage/$part"
  for f in "${files[@]:start:chunk}"; do cp "$f" "$stage/$part/"; done

  # Script batch eseguito nella VM: le unità mappate non esistono nel contesto di prlctl, quindi percorsi UNC
  printf '@echo off\r\n"%s" --i-agree-to-the-eula %s -p "%s\\%s\\%s" -s "%s\\%s\\style.json" > "%s\\%s\\%s.log" 2>&1\r\necho %%ERRORLEVEL%% > "%s\\%s\\%s.exit"\r\n' \
    "$CLI" "$casing" "$UNC_ROOT" "$run" "$part" "$UNC_ROOT" "$run" "$UNC_ROOT" "$run" "$part" "$UNC_ROOT" "$run" "$part" > "$stage/$part.cmd"

  # prlctl exec a volte cade (VM sospesa, sessione interrotta): si riprova il blocco
  for attempt in 1 2 3; do
    rm -f "$stage/$part.exit"
    prlctl exec "$VM" cmd /c "$UNC_ROOT\\$run\\$part.cmd" >/dev/null 2>&1 || true
    [[ -f "$stage/$part.exit" ]] && break
    prlctl resume "$VM" >/dev/null 2>&1 || true
    sleep 5
  done
  [[ -f "$stage/$part.exit" ]] || { echo "blocco $part fallito dopo 3 tentativi" >&2; exit 1; }

  code=$(tr -d '\r\n ' < "$stage/$part.exit")
  # La CLI esce con 0 anche quando non trova lo stile: l'errore va letto dal log
  if [[ "$code" != "0" ]] || grep -q "Error encountered" "$stage/$part.log"; then
    cat "$stage/$part.log" >&2
    exit 1
  fi
  # File non parsabili: la CLI li lascia invariati e lo segnala nel log
  grep -i -E "fail|skip|could not" "$stage/$part.log" >&2 || true
  cp "$stage/$part/"*.sql "$out/"
done
