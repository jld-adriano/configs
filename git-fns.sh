#!/usr/bin/env zsh

alias gcane="git commit --amend --no-edit"
alias gl="git log --color --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"

# Interactive add new files
gap() {
  git_root=$(git rev-parse --show-toplevel)
  git status --porcelain | grep '^??' | cut -c4- | xargs -I{} git add -N ${git_root}/{}
  git add -p $@
}

# Pretty status
gs() { 
  git -c color.ui=always status $@ | less -R
}

# Interactive fixup commit 
unalias gcf 2>/dev/null
gcf() {
  if [[ -z $1 ]]; then
    # List last 30 commits
    LAST_COMMITS=$(git log --pretty=format:"%h %s" -100 | grep -v "fixup")
    LAST_COMMITS_COUNT=$(echo "${LAST_COMMITS}" | wc -l)
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
gcv() {
    EDITOR=neovim git commit -v
}

# Pull rebase with squash
gprps() {
  # Refuse if in the middle of a rebase
  git status | grep -q 'rebase in progress';
  if [[ $? -eq 0 ]]; then
    echo "You are in the middle of a rebase. Finish it before pushing"
    return 1
  fi
  git reset && git pull --rebase --autostash && gass
}

gprpsp() {
  gprps && git push

}

# Rebase with autosquash and rebase
gass() {
  GIT_SEQUENCE_EDITOR=true git rebase --autosquash -i --autostash
}
