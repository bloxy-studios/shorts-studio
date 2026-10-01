#!/bin/sh
# Shorts Studio SessionStart hook — fast readiness check only (never installs anything).
# Plugin variables are not visible to Bash-tool commands, so persist the runtime
# location for the CLI through CLAUDE_ENV_FILE (documented SessionStart mechanism).
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -d "$ROOT/.runtime/venv" ]; then
  HOME_DIR="$ROOT/.runtime"            # development checkout with a local runtime
elif [ -n "$CLAUDE_PLUGIN_DATA" ]; then
  HOME_DIR="$CLAUDE_PLUGIN_DATA"       # installed plugin: persistent per-plugin data dir
else
  HOME_DIR="$HOME/.shorts-studio"
fi
if [ -n "$CLAUDE_ENV_FILE" ]; then
  {
    printf 'export SHORTS_STUDIO_HOME=%s\n' "\"$HOME_DIR\""
    printf 'export SHORTS_STUDIO_PLUGIN_ROOT=%s\n' "\"$ROOT\""
  } >> "$CLAUDE_ENV_FILE"
fi
missing=""
[ -x "$HOME_DIR/venv/bin/python" ] || missing="$missing python-env"
[ -x "$HOME_DIR/node/node_modules/.bin/hyperframes" ] || missing="$missing hyperframes"
[ -x "$HOME_DIR/bin/whisper-cli" ] || missing="$missing whisper.cpp"
command -v ffmpeg >/dev/null 2>&1 || missing="$missing ffmpeg"
command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ] || missing="$missing bun"
if [ -z "$missing" ]; then
  status="Shorts Studio runtime ready at $HOME_DIR. CLI: \"$ROOT/bin/shorts-studio\" (also on the Bash PATH as shorts-studio)."
else
  status="Shorts Studio runtime incomplete (missing:$missing). Before editing video, run \"$ROOT/bin/shorts-studio\" doctor --setup (project-local install, no sudo) or ask the user first if they prefer."
fi
# Minimal JSON escaping for the status line.
esc=$(printf '%s' "$status" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$esc"
