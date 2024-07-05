
# Oh My Zsh config
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git brew kubectl aws bun github)
source $ZSH/oh-my-zsh.sh

# Atuin shell history
. "$HOME/.atuin/bin/env"
eval "$(atuin init zsh)"

# Starship prompt
eval "$(starship init zsh)"

# Custom configuration from repo
# This might need to change in new installs
source /Users/jldadriano/projs/configs/src.sh
