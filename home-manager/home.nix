{ config, pkgs, shellConfig, ... }:
let
  gitAliases = ''
    #!/usr/bin/env zsh

    alias gcane="git commit --amend --no-edit"
    alias gl="git log --color --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit"

    # Interactive add new files
    unalias gap 2>/dev/null
    function gap(){
      git_root=$(git rev-parse --show-toplevel)
      git status --porcelain | grep '^??' | cut -c4- | xargs -I{} git add -N $''${git_root}/{}
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
        LAST_COMMITS_COUNT=$(echo "$''${LAST_COMMITS}" | wc -l | tr -d ' ')
        # Select commit
        SELECTED_COMMIT=$(echo "$''${LAST_COMMITS}" | fzf --height $''${LAST_COMMITS_COUNT} --reverse --border)
        # Get commit hash
        COMMIT_HASH=$(echo "$''${SELECTED_COMMIT}" | awk '{print $1}')

        if [[ -z $COMMIT_HASH ]]; then
          echo "No commit selected"
          return 1
        fi

        # Fixup that commit
        git commit --fixup "$''${COMMIT_HASH}"
        return 0
      fi
      git commit --fixup "$''${@}"
    }

    # Pull rebase with squash
    function gprps() {
      # Refuse if in the middle of a rebase
      git status | grep -q 'rebase in progress';
      if [[ $? -eq 0 ]]; then
        echo "You are in the middle of a rebase. Finish it before pushing"
        return 1
      fi
      git reset && sleep 0.3 && git pull --rebase --autostash && gass
    }

    function gprpsp() {
      gprps && git push
    }

    # Rebase with autosquash and rebase
    function gass() {
      GIT_SEQUENCE_EDITOR=true git rebase --autosquash -i --autostash
    }

    function _get-github-token() {
      temp_file=$(mktemp)
      # Run gh auth login in the background and redirect output to a temp file
      (gh auth login -w -p ssh -h Github.com --skip-ssh-key 2>&1 | tee "$temp_file") &
      # Wait until the one-time code is found in the temp file
      while ! grep -q "one-time code" "$temp_file"; do
        echo "Waiting for one-time code..."
        sleep 0.5
      done
      open "https://github.com/login/device"
      echo "One-time code found, copying to clipboard..."
      one_time_code=$(grep "one-time code" "$temp_file" | awk '{print $7}')
      echo -n "$one_time_code" | pbcopy  # For macOS; use xclip or xsel for Linux
      echo "One-time code $one_time_code copied to clipboard."
      wait
      gh auth status --show-token
      echo "Logging out..."
      gh auth logout
      rm "$temp_file"
    }
    function get-github-token() {
      temp_file=$(mktemp)
      _get-github-token 2>&1 | tee "$temp_file" >&2
      token=$(grep Token: "$temp_file" | cut -d ':' -f2 | tr -d ' ')
      rm "$temp_file"
      echo "$token"
    }
  '';

  zshrc = ''
    export EDITOR="nvim"

    # Oh My Zsh config
    ZSH_THEME="robbyrussell"
    plugins=(git brew kubectl aws bun github)

  '';
  postzshrc = ''
    eval "$(atuin init zsh)"
  '';

  randomAliases = ''
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
    function _cproj() {
        reuse_window=$1
        name=$2
        if [ -z "$name" ]; then
            name="$(find ~/projs -mindepth 1 -maxdepth 1 -type d | fzf --prompt="Select project file to edit (Ctrl+C to exit): ")"
        fi
        if [ -z "$name" ]; then
            echo "No project file to edit."
            return
        fi
        if [ "$reuse_window" = true ]; then
            cursor -r $name
        else
            cursor $name
        fi
    }
    function crproj() {
        _cproj true $1
    }
    function cproj() {
        _cproj false $1
    }
  '';
in {
  home.username = "jldadriano";
  home.homeDirectory = "/Users/jldadriano";
  home.stateVersion = "24.05";

  home.packages = [
    pkgs.htop
    pkgs.nerdfonts
    pkgs.atuin
    pkgs.zsh
    pkgs.btop
    pkgs.neovim
    pkgs.gh
    pkgs.curl
    pkgs.fzf
    pkgs.reflex
    pkgs.bun
  ];
  programs.home-manager.enable = true;

  programs.zsh = {
    enable = true;

    initExtraFirst = zshrc;
    initExtra = postzshrc + gitAliases + randomAliases;

    shellAliases = {
      "reload-home-manager" =
        "zsh -c 'cd ~/projs/configs/home-manager && nix run home-manager/release-24.05 -- switch --flake ~/projs/configs/home-manager#home' && zsh";
      "ba" = "bun add";
      "bad" = "bun add --dev";
      "bw" = "bun run --watch";
      "br" = "bun remove";
      "bi" = "bun install";
    };
    oh-my-zsh = { enable = true; };
  };

  programs.starship.enable = true;
  programs.git = {
    enable = true;
    userName = "Adriano";
    userEmail = "jld.adriano@gmail.com";
  };

  # home.file = {
  #   # ... existing file configurations ...
  #   ".config/atuin/config.toml".text =
  #     builtins.readFile "${configsDir}/atuin-config.toml";
  # };

  home.sessionVariables = { REDITOR = "nvim"; };

  launchd.agents.home-manager-daemon = {
    enable = true;
    config = {
      ProgramArguments = [ "bun" "run" "--watch" "index.ts" ];
      WorkingDirectory =
        "${config.home.homeDirectory}/../nix-home-manager-daemon/";
      KeepAlive = true;
      RunAtLoad = true;
      StandardOutPath = "/tmp/home-manager-daemon.log";
      StandardErrorPath = "/tmp/home-manager-daemon.error.log";
    };
  };
}