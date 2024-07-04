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