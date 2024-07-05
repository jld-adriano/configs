#!/usr/bin/env zsh

set -eo pipefail

# Nix base setup
if [ ! -f /etc/nix/nix.conf ]; then
  sh <(curl -L https://nixos.org/nix/install)
fi

sudo rm -rf /etc/nix/nix.conf
sudo ln -s $(pwd)/nix.conf /etc/nix/nix.conf

local_home_manager_dir="$(pwd)/home-manager"
user_home_manager_config_dir="$HOME/.config/home-manager"
# Home manager setup
rm -rf $user_home_manager_config_dir
mkdir -p $user_home_manager_config_dir
ln -s $local_home_manager_dir/home.nix $user_home_manager_config_dir/home.nix
ln -s $local_home_manager_dir/flake.nix $user_home_manager_config_dir/flake.nix
ln -s $local_home_manager_dir/flake.lock $user_home_manager_config_dir/flake.lock
nix run home-manager/release-24.05 -- switch --flake $local_home_manager_dir#home


# # Home manager darwin
# mkdir -p ~/.config/nix
# rm -rf ~/.config/nix/flake.nix
# (cd ~/.config/nix && nix flake init -t nix-darwin)
# rm -rf ~/.config/nix/flake.nix
# ln -s $(pwd)/flake.nix ~/.config/nix/flake.nix

# Atuin
# curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh


# #starship
# curl -sS https://starship.rs/install.sh | sh

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