#!/usr/bin/env bash
# Installs r7Shell. Run it in WSL from anywhere: bash install.sh
set -e
repo=$(cd "$(dirname "$0")" && pwd)

command -v cmd.exe >/dev/null && command -v wslpath >/dev/null || { echo "Run this inside WSL, with Windows interop on."; exit 1; }
node=$(command -v node) || { echo "Needs Node.js 22.12 or newer in WSL (https://nodejs.org or nvm)."; exit 1; }
command -v npm >/dev/null || { echo "Needs npm."; exit 1; }
major=$("$node" -p 'process.versions.node.split(".")[0]')
minor=$("$node" -p 'process.versions.node.split(".")[1]')
{ [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; }; } || { echo "Needs Node.js 22.12 or newer (found $("$node" -v))."; exit 1; }
command -v make >/dev/null && command -v g++ >/dev/null || echo "Note: node-pty builds from source; if it fails, run: sudo apt install build-essential python3"

echo "Daemon packages..."
(cd "$repo/daemon" && npm ci --no-audit --no-fund)

# The app runs on Windows, so it gets the Windows build of Electron (electron.exe).
echo "App packages (Windows Electron)..."
(cd "$repo/app" && npm_config_platform=win32 npm_config_arch=x64 npm ci --no-audit --no-fund)
[ -f "$repo/app/node_modules/electron/dist/electron.exe" ] || { echo "electron.exe is missing from app/node_modules/electron/dist."; exit 1; }

mkdir -p "$HOME/.local/bin"
cat >"$HOME/.local/bin/r7shell" <<EOF
#!/bin/sh
exec "$node" "$repo/cli/r7shell.js" "\$@"
EOF
chmod +x "$HOME/.local/bin/r7shell"

# Settings live in %LOCALAPPDATA%\r7shell; fill in node and distro if they're not set.
state=$("$node" -p 'require(process.argv[1]).stateDir()' "$repo/daemon/common.js")
mkdir -p "$state"
"$node" -e '
const fs = require("fs");
const [file, node, distro] = process.argv.slice(1);
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (!s.node) s.node = node;
if (!s.distro && distro) s.distro = distro;
fs.writeFileSync(file, JSON.stringify(s, null, 2));
' "$state/settings.json" "$node" "${WSL_DISTRO_NAME:-}"

cat <<EOF

r7Shell is installed. Settings: $state/settings.json
EOF
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH first (e.g. in ~/.bashrc)."; esac
cat <<'EOF'

Start it:
  r7shell new bash --activate      a bash window
  r7shell new claude --activate    Claude Code
  r7shell new codex --activate     Codex
  r7shell help                     everything else

Flash the window when a turn finishes:
  Claude Code, in ~/.claude/settings.json:
    "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "r7shell done" } ] } ] }
  Codex, in ~/.codex/config.toml:
    notify = ["r7shell", "done"]
EOF
