#!/usr/bin/env zsh

set -eo pipefail

# Nix base setup
sh <(curl -L https://nixos.org/nix/install)
sudo rm -rf /etc/nix/nix.conf
sudo ln -s $(pwd)/nix.conf /etc/nix/nix.conf

nix-channel --add https://github.com/nix-community/home-manager/archive/master.tar.gz home-manager
nix-channel --update

nix-shell '<home-manager>' -A install

rm -rf ~/.config/home-manager/home.nix
ln -s $(pwd)/home.nix ~/.config/home-manager/home.nix


# Home manager darwin
mkdir -p ~/.config/nix
rm -rf ~/.config/nix/flake.nix
(cd ~/.config/nix && nix flake init -t nix-darwin)
rm -rf ~/.config/nix/flake.nix
ln -s $(pwd)/flake.nix ~/.config/nix/flake.nix

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