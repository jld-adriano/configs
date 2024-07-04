#!/usr/bin/env zsh
# Atuin
curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh

#starship
curl -sS https://starship.rs/install.sh | sh

# Install Homebrew packages
brew install jq qq curl neovim fzf starship

# Install casks
brew install --cask cursor raycast

