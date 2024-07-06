#!/usr/bin/env zsh

set -eo pipefail

# Nix base setup
if [ ! -f /etc/nix/nix.conf ]; then
  sh <(curl -L https://nixos.org/nix/install)
fi

sudo rm -rf /etc/nix/nix.conf
sudo ln -s $(pwd)/nix.conf /etc/nix/nix.conf

# Home manager setup
nix run home-manager/release-24.05 -- switch --flake $(dirname $0)/home-manager#home

# # Install Homebrew packages
# brew install jq curl neovim fzf starship reflex github asdf
# brew install jfryy/tap/qq 

# asdf plugin add nodejs
# asdf plugin add pnpm
# asdf install nodejs 20.11.0

# volta install node

# # Install casks
# brew install --cask cursor raycast

# xargs -n 1 cursor --install-extension < vscode/extensions.list