#!/usr/bin/env zsh

set -eo pipefail

# Nix base setup
if [ ! -f /etc/nix/nix.conf ] && ! command -v nix >/dev/null 2>&1; then
  echo "Installing Nix..."
  sh <(curl -L https://nixos.org/nix/install)
fi

# Darwin setup (only on macOS)
if [ "$(uname)" = "Darwin" ]; then
  echo "Setting up nix-darwin..."
  
  # Move existing files that Darwin will manage
  if [ -f /etc/nix/nix.conf ] && [ ! -L /etc/nix/nix.conf ]; then
    echo "Moving existing /etc/nix/nix.conf..."
    sudo mv /etc/nix/nix.conf /etc/nix/nix.conf.before-nix-darwin
  fi
  
  if [ -f /etc/bashrc ] && [ ! -L /etc/bashrc ]; then
    echo "Moving existing /etc/bashrc..."
    sudo mv /etc/bashrc /etc/bashrc.before-nix-darwin
  fi
  
  # Build and apply Darwin configuration
  cd darwin
  echo "Building Darwin configuration..."
  nix build .#darwinConfigurations.joaoadriano.system
  echo "Applying Darwin configuration (requires password)..."
  sudo ./result/sw/bin/darwin-rebuild switch --flake .#joaoadriano
  cd ..
fi

# Test nix develop
cd aws-console
nix develop --command echo 'Hello from nix develop!'
cd ..

# Home manager setup
echo "Setting up Home Manager..."
nix run home-manager/release-24.05 -- switch --flake $(dirname $0)/home-manager#home

# VSCode setup
mkdir -p ~/Library/Application\ Support/Code/User
# Link vscode settings to appropriate directories
# If you use cursor, change Code to Cursor
ln -s $(pwd)/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -s $(pwd)/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json

if [ -d ~/Library/Application\ Support/Cursor ]; then 
  # Cursor setup
  ln -s $(pwd)/vscode/keybindings.json ~/Library/Application\ Support/Cursor/User/keybindings.json
  ln -s $(pwd)/vscode/settings.json ~/Library/Application\ Support/Cursor/User/settings.json
fi

echo "✅ Bootstrap complete!"
echo ""
echo "Available commands:"
echo "  reload-home-manager - Rebuild both Darwin and Home Manager configurations"
echo "  reload-darwin      - Rebuild only Darwin configuration"  
echo "  reload-hm          - Rebuild only Home Manager configuration"
echo "  nix-clean          - Clean up old Nix generations"
echo ""
echo "Note: Homebrew and age-plugin-se have been installed via Darwin configuration."