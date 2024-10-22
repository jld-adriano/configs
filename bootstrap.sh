#!/usr/bin/env sh

set -eo pipefail

# Nix base setup
if [ ! -f /etc/nix/nix.conf ] && [ ! $(which nix) ]; then
  sh <(curl -L https://nixos.org/nix/install)
fi

sudo mkdir -p /etc/nix
sudo rm -rf /etc/nix/nix.conf
sudo ln -s $(pwd)/nix.conf /etc/nix/nix.conf

# Home manager setup
nix run home-manager/release-24.05 -- switch --flake $(dirname $0)/home-manager#home

# TODO: Doesn't have a nix package :(
if [ ! $(which age-plugin-se) ] && [ $(uname) = "Darwin" ]; then
  brew install age-plugin-se
fi

# VSCode setup
mkdir -p ~/Library/Application\ Support/Code/User
# Link vscode settings to appropriate directories
# If you use cursor, change Code to Cursor
ln -s $(pwd)/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -s $(pwd)/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json
