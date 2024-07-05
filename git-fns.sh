#!/usr/bin/env zsh

alias gcane="git commit --amend --no-edit"
alias gl="git log --color --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"
export EDITOR=neovim

# Interactive add new files
unalias gap 2>/dev/null
function gap(){
  git_root=$(git rev-parse --show-toplevel)
  git status --porcelain | grep '^??' | cut -c4- | xargs -I{} git add -N ${git_root}/{}
  git add -p $@
}

# Pretty status
function gs(){ 
  git -c color.ui=always status $@ | less -R
}

# Interactive fixup commit 
unalias gcf 2>/dev/null
function gcf(){
  if [[ -z $1 ]]; then
    # List last 30 commits
    LAST_COMMITS=$(git log --pretty=format:"%h %s" -100 | grep -v "fixup")
    LAST_COMMITS_COUNT=$(echo "${LAST_COMMITS}" | wc -l | tr -d ' ')
    # Select commit
    SELECTED_COMMIT=$(echo "${LAST_COMMITS}" | fzf --height ${LAST_COMMITS_COUNT} --reverse --border)
    # Get commit hash
    COMMIT_HASH=$(echo "${SELECTED_COMMIT}" | awk '{print $1}')

    if [[ -z $COMMIT_HASH ]]; then
      echo "No commit selected"
      return 1
    fi

    # Fixup that commit
    git commit --fixup "${COMMIT_HASH}"
    return 0
  fi
  git commit --fixup "${@}"
}

# Commit with neovim
function gcv() {
    EDITOR=neovim git commit -v
}

# Pull rebase with squash
function gprps() {
  # Refuse if in the middle of a rebase
  git status | grep -q 'rebase in progress';
  if [[ $? -eq 0 ]]; then
    echo "You are in the middle of a rebase. Finish it before pushing"
    return 1
  fi
  git reset && git pull --rebase --autostash && gass
}

function gprpsp() {
  gprps && git push

}

# Rebase with autosquash and rebase
function gass() {
  GIT_SEQUENCE_EDITOR=true git rebase --autosquash -i --autostash
}
