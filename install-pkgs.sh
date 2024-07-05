#!/usr/bin/env zsh

sh <(curl -L https://nixos.org/nix/install)

mkdir -p ~/.config/nix
cd ~/.config/nix
nix --extra-experimental-features nix-command --extra-experimental-features flakes flake init -t nix-darwin
sed -i '' "s/simple/$(scutil --get LocalHostName)/" flake.nix

# Atuin
curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh


#starship
curl -sS https://starship.rs/install.sh | sh

# Install Homebrew packages
brew install jq curl neovim fzf starship reflex github asdf
brew install jfryy/tap/qq 

asdf plugin add nodejs
asdf plugin add pnpm
asdf install nodejs 20.11.0

volta install node

# Install casks
brew install --cask cursor raycast

xargs -n 1 cursor --install-extension < vscode/extensions.list