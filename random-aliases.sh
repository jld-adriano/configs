#/usr/bin/env zsh
alias configs="cursor $(dirname $0)"
function delete-untracked-interactive() {
    git reset
    #fzf loop to delete untracked files
    while true; do
        untracked_files=$(git ls-files --others --exclude-standard)
        if [ -z "$untracked_files" ]; then
            echo "No untracked files to delete."
            return
        fi
        file=$(echo "$untracked_files" | fzf --prompt="Select file to delete (Ctrl+C to exit): ")
        if [ -z "$file" ]; then
            break
        fi
        rm "$file"
    done
}

alias cr="cursor -r"
alias c="cursor"
function cproj() {
    name=$1
    if [ -z "$name" ]; then
        name="$(find ~/projs -mindepth 1 -maxdepth 1 -type d | fzf --prompt="Select project file to edit (Ctrl+C to exit): ")"
    fi
    if [ -z "$name" ]; then
        echo "No project file to edit."
        return
    fi
    cursor $name
}