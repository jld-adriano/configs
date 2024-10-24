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
      git status --porcelain | grep '^??' | cut -c4- | xargs -I{} git add -N ''${git_root}/{}
      git add -p $@
      cd $git_root
      # Reset all unstaged new files
      all_unstaged=$(git ls-files --modified --others --exclude-standard)
      if [[ -n $all_unstaged ]]; then
        git reset -- $all_unstaged
      fi
      cd -
    }

    # Pretty status
    function gs(){ 
      git -c color.ui=always status $@ | less -R
    }

    unalias gr 2>/dev/null
    alias gr="git reset"

    # Interactive fixup commit 
    unalias gcf 2>/dev/null
    function gcf(){
      if [[ -z $1 ]]; then
        # List last 30 commits
        LAST_COMMITS=$(git log --pretty=format:"%h %s" -100 | grep -v "fixup")
        LAST_COMMITS_COUNT=$(echo "''${LAST_COMMITS}" | wc -l | tr -d ' ')
        # Select commit
        SELECTED_COMMIT=$(echo "''${LAST_COMMITS}" | fzf --height ''${LAST_COMMITS_COUNT} --reverse --border)
        # Get commit hash
        COMMIT_HASH=$(echo "''${SELECTED_COMMIT}" | awk '{print $1}')

        if [[ -z $COMMIT_HASH ]]; then
          echo "No commit selected"
          return 1
        fi

        # Fixup that commit
        git commit --fixup "''${COMMIT_HASH}"
        return 0
      fi
      git commit --fixup "''${@}"
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

    function gprpspt() {
      gprps && git push --tags
    }

    # Rebase with autosquash and rebase
    function gass() {
      GIT_SEQUENCE_EDITOR=true git rebase --autosquash -i --autostash
    }

    function gitroot() {
      cd $(git rev-parse --show-toplevel)
    }
    function gitr() {
      gitroot
    }
    function gswitch() {
      local branch
      if [ $# -eq 0 ]; then
        selected_branch=$(git for-each-ref --sort=-committerdate refs/heads/ --format='%(refname:short)' | fzf --preview 'git log -n 10 --oneline {}')
        if [ -n "$selected_branch" ]; then
          branch=$selected_branch
        else
          echo "No branch selected"
          return 1
        fi
      else
        branch=$1
      fi
      git reset && git stash && git switch "$branch" && git stash pop
    }
    function _gswitch_completion() {
      local -a branches
      branches=($(git branch --format='%(refname:short)'))
      _describe 'branches' branches
    }
    compdef _gswitch_completion gswitch

    unalias gcv 2>/dev/null
    function gcv() {
      git commit --no-verify $@
    }
    function gcva() {
      git commit --amend --no-verify $@
    }

    unalias gca 2>/dev/null
    function gca() {
      git commit --amend
    }
    unalias gra 2>/dev/null
    function gra() {
      if [ $# -eq 0 ]; then
        local branch=$(fzf-branch)
        if [ -n "$branch" ]; then
          git rebase --autostash "$branch"
        else
          echo "No branch selected"
          return 1
        fi
      else
          git rebase --autostash "$1"
        fi
    }

    function fzf-branch() {
      local branch=$(git for-each-ref --sort=-committerdate refs/heads/ --format='%(refname:short)' | fzf --preview 'git log -n 10 --oneline {}')
      echo $branch
    }

    function rebi() {
      git rebase --interactive --autostash HEAD~''${1:-10}
    }
    
    function rebisquash() {
      git rebase --interactive --autostash --autosquash HEAD~''${1:-10}
    }
    
    function g-clean-worktree () {
    
        trap 'echo -e "\nInterrupted by user"; exit 1' INT

        while true; do
            # List only sub-worktrees (exclude main worktree) and select
            WORKTREE=$(git worktree list | sed '1d' | fzf --height 80% --reverse) || exit 0

            if [ -n "$WORKTREE" ]; then
                WORKTREE_PATH=$(echo "$WORKTREE" | awk '{print $1}')
                git worktree remove --force "$WORKTREE_PATH"
                echo "Removed worktree: $WORKTREE_PATH"
            fi
        done
    }

    function gh-pr-worktree () {
      export AGE_ENV_CONFIG_DIR=$HOME/.age-env
      eval "$(age-env show-for-eval gh)"
      
      # select pr
      pr=$(gh pr list --state open --json number,title --jq '.[] | "\(.number): \(.title)"' | fzf --prompt="Select PR: ")
      if [[ -z $pr ]]; then
        echo "No PR selected"
        return 1
      fi

      echo "Selected PR: $pr"
      # extract the PR number
      pr_number=$(echo $pr | cut -d':' -f1)
      if [[ -z $pr_number ]]; then
        echo "No pull requests found"
        return 1
      fi
      branch=$(gh pr view $pr_number --json headRefName --jq '.headRefName')
      if [[ -z $branch ]]; then
        echo "Failed to fetch branch for PR $pr_number"
        return 1
      fi
      sanitized_branch=$(echo $branch | tr '/' '-')
      root=$(git rev-parse --show-toplevel)
      git worktree add $root/worktree-prs/$pr__$sanitized_branch $branch

      cursor $root/worktree-prs/$pr__$sanitized_branch
      cd $root/worktree-prs/$pr__$sanitized_branch
      direnv allow
      nix develop
    }

    function save_staged_state_and_reset() {
      # Save the current staged state to a temporary file
      local tmp_file=/tmp/staged_patch.patch
      
      (cd $(git rev-parse --show-toplevel) && git diff --cached > "$tmp_file")
      echo "Staged state saved to $tmp_file"
      
      # Reset the repository
      git reset
    }

    function apply_staged_state() {
      local tmp_file=/tmp/staged_patch.patch
      
      
      # Reapply the staged state
      (cd $(git rev-parse --show-toplevel) && git apply --cached < "$tmp_file")
      if [[ $? -ne 0 ]]; then
        echo "There was a problem applying the patch. The staged state is saved in $tmp_file"
      fi
    }

    function gi-delete-merged() {
      while true; do
        branch=$(git branch --merged | grep -Ev "(^\*|master|main|dev|staging)" | sed 's/^[[:space:]]*//' | fzf --preview 'git log -n 20 --oneline {}' || true)
        if [ -z "$branch" ]; then
          break
        fi
        git branch -d "$branch" && echo ":DELETED $branch"
      done
    }

    function g-rebase-branch-push-force() {
      if [[ -z $1 ]]; then
        echo "Please provide a branch name"
        return 1
      fi
      main_branch=$(git branch --show-current)
      gprpsp && \
      gswitch $1 && \
      git rebase $main_branch --autostash && \
      git push --force && \
      gswitch $main_branch
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

    function share-wormhole-env() {
      age-env show $1 | wormhole-rs send --rename $1 - 2&>1 /tmp/wormhole_env_$1 &
      wormhole_pid=$!
      sleep 2
      echo "Waiting for wormhole to finish"
      secret_name=$(cat /tmp/wormhole_env_$1 | grep -v 'wormhole-rs send' | grep 'wormhole-rs receive' | awk '{print $4}')
      echo "wormhole receive $secret_name" | pbcopy
      echo "Copied to clipboard $secret_name"
      wait $wormhole_pid
      rm /tmp/wormhole_env_$1
    }

    alias grc="git rebase --continue"

  '';

  zshrc = ''
    export EDITOR="nvim"

    # Oh My Zsh config
    ZSH_THEME="robbyrussell"
    plugins=(git brew kubectl aws bun github npm helm gh npm node nix)

    bindkey -v

  '';
  postzshrc = ''
    eval "$(atuin init zsh)"
  '';

  randomAliases = ''
    #/usr/bin/env zsh

    alias awswho="aws sts get-caller-identity"

    alias configs="cursor ~/projs/configs"
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

    alias ex="cd ~/projs/monorepo"

    alias cr="cursor -r"
    alias c="cursor"
    function _cproj() {
        reuse_window=$1
        name=$2
        if [ -z "$name" ]; then
            dir="$(find ~/projs -mindepth 1 -maxdepth 1 -type d | fzf --prompt="Select project file to edit (Ctrl+C to exit): ")"
        else
          dir=~/projs/$name
        fi

        if [ -z "$dir" ]; then
            echo "No project file to edit."
            return
        fi

      
        if [ "$reuse_window" = true ]; then
            cursor -r $dir
        else
            cursor $dir
        fi
    }
    function crproj() {
        _cproj true $1
    }
    function cproj() {
        _cproj false $1
    }

    function flakebuild() {
      is_staged=$(git diff --cached --name-only)
      if [[ -n $is_staged ]]; then
        echo "Saving staged state"
        save_staged_state_and_reset
        echo "Adding all files"
      fi
      git add -A
      echo "Building flake"
      nix build $@
      git reset
      if [[ -n $is_staged ]]; then
        echo "Staged state reapply"
        apply_staged_state
      fi
    }

    function flakeupdate() {
      is_staged=$(git diff --cached --name-only)
      if [[ -n $is_staged ]]; then
        echo "There are staged changes. Please commit or stash them before updating the flake."
        return 1
      fi
      nix flake update
      git add flake.lock
      git commit --edit --message="Update flake"
    }

    alias dirrel="direnv reload"

    function wait-for-port() {
      while ! nc -z localhost $1; do
        sleep 0.1
      done
      echo "Port $1 is open"
    }

    function apple-notify() {
      osascript -e "display notification \"$2\" with title \"$1\""
    }

    function create-sh-script() {
      echo "#!/usr/bin/env sh" > $1
      chmod +x $1
      $EDITOR $1
    }

    alias kd="kubectl describe"

  '';
  ageEnvStuff = ''

    alias ae="age-env"
    _age-env-list-for-completions() {
      _values "age-env" $(age-env list --short)
    }
    compdef _age-env-list-for-completions rwe
    compdef _age-env-list-for-completions rwes

    function rwe() {
      age-env run-with-env ''${1} -- ''${@:2}
    }
    alias gh="rwe gh gh"
    function rwes() {
      age-env run-with-env ''${1} -- zsh
    }

    compdef _age-env-list-for-completions aes
    function aes() {
      local v_flag
      if [[ ! -z $2 ]]; then
        v_flag="-v ''${2// /}"
      fi
      age-env show $v_flag ''${1}
    }

    reinstall-age-env() {
      brew uninstall age-env && brew untap jld-adriano/age-env && brew tap jld-adriano/age-env &&
      brew install age-env && age-env list
    }

    compdef _age-env-list-for-completions ae-rewrite

    ae-rewrite() {
      contents=$(age-env show $1) 
      echo "$contents" | vipe | age-env c -y $1
      echo "previous contents:"
      echo "$contents"
      echo "new contents:"
      age-env show $1
    }

    aespre() {
      eval $(age-env show-for-eval -l $1)
    }
  '';
  navigationTools = ''

    function nfind() {
      root=$(git rev-parse --show-toplevel)
      package_json_files=$(cd $root && git ls-files --full-name **/package.json | sed 's/\/package.json$//')
      match=$(echo "$package_json_files" | grep -x ".*/$1")
      if [[ -n $match ]]; then
        echo "$(realpath --relative-to=. "$root")/$match"
      else
        echo "No exact match found for $1" 1>&2
        exit 1
      fi
    }

    function _ngt_completions() {
      local root=$(git rev-parse --show-toplevel)
      local package_json_files=$(cd $root && git ls-files --full-name | grep package.json | sed 's/\/package.json$//')
      _values "package.json files" ''${(f)package_json_files}
    }

    compdef _ngt_completions ngt


    function ngt() {
      export DIRENV_LOG_FORMAT=""
      root=$(git rev-parse --show-toplevel)
      cache_file="$root/.cache/ngt-pkg-json-list"
      mkdir -p $root/.cache
      if [[ -f $cache_file ]]; then
        package_json_files=$(cat $cache_file)
        $(cd $root && git ls-files --full-name | grep package.json | sed 's/\/package.json$//'> $cache_file) >&/dev/null &
      else
        package_json_files=$(cd $root && git ls-files --full-name | grep package.json | sed 's/\/package.json$//')
        echo "$package_json_files" > $cache_file
      fi
      temp_file=$(mktemp)
      echo "$package_json_files" | fzf -q "$1" --select-1 --exit-0 | tee "$temp_file"
      selected=$(cat "$temp_file")
      rm "$temp_file"
      if [[ -z $selected ]]; then
        echo "No package.json file selected"
        return 1
      fi
      cd $root/$selected
    }

    function _pgt_completions() {
      local root=$(git rev-parse --show-toplevel)
      local pyproj_files=$(cd $root && git ls-files --full-name | grep pyproject.toml | sed 's/\/pyproject.toml$//')
      _values "pyproject.toml files" ''${(f)pyproj_files}
    }

    compdef _pgt_completions pgt

    function pgt() {
      export DIRENV_LOG_FORMAT=""
      root=$(git rev-parse --show-toplevel)
      cache_file="$root/.cache/pgt-pyproj-list"
      mkdir -p $root/.cache
      if [[ -f $cache_file ]]; then
        pyproj_files=$(cat $cache_file)
        $(cd $root && git ls-files --full-name | grep pyproject.toml | sed 's/\/pyproject.toml$//'> $cache_file) >&/dev/null &
      else
        pyproj_files=$(cd $root && git ls-files --full-name | grep pyproject.toml | sed 's/\/pyproject.toml$//')
        echo "$pyproj_files" > $cache_file
      fi
      temp_file=$(mktemp)
      echo "$pyproj_files" | fzf -q "$1" --select-1 --exit-0 | tee "$temp_file"
      selected=$(cat "$temp_file")
      rm "$temp_file"
      if [[ -z $selected ]]; then
        echo "No pyproject.toml file selected"
        return 1
      fi
      cd $root/$selected
    }

  '';
  awsTools = ''
    function delete-all-my-aws-access-keys() {
      aws iam list-access-keys --user-name $(aws sts get-caller-identity --query "Arn" --output text | awk -F'/' '{print $NF}') --query 'AccessKeyMetadata[*].AccessKeyId' --output text  | xargs -n1 echo | xargs -n 1 -I {} aws iam delete-access-key --user-name $(aws sts get-caller-identity --query "Arn" --output text | awk -F'/' '{print $NF}') --access-key-id {}
    }
    function get-aws-username() {
      aws sts get-caller-identity --query "Arn" --output text | awk -F'/' '{print $NF}'
    }

    function create-my-single-aws-token-env () {
      delete-all-my-aws-access-keys 
      aws iam create-access-key --user-name $(get-aws-username) --query 'AccessKey.{AccessKeyId:AccessKeyId,SecretAccessKey:SecretAccessKey}' --output json \
      | jq -r '.AccessKeyId as $id | .SecretAccessKey as $key | "AWS_ACCESS_KEY_ID=\($id) \nAWS_SECRET_ACCESS_KEY=\($key)"' \
      | vipe
    }
  '';
  fluxCompletion = pkgs.writeTextFile {
    name = "flux-completion.zsh";
    text = builtins.readFile (pkgs.runCommand "generate-flux-completion" {
      buildInputs = [ pkgs.fluxcd ];
    } ''
      mkdir -p $out
      flux completion zsh > $out/flux-completion.zsh
    '' + "/flux-completion.zsh");
  };
  ageEnvCompletion = pkgs.writeTextFile {
    name = "age-env-completion.zsh";
    text = builtins.readFile (pkgs.runCommand "generate-age-env-completion" {
      buildInputs = [ pkgs.age pkgs.age-env ];
    } ''
      mkdir -p $out
      age-env generate zsh > $out/age-env-completion.zsh
    '' + "/age-env-completion.zsh");
  };
  completions = ''
    source ${fluxCompletion}
    source ${ageEnvCompletion}
  '';
  generateProgramArguments = dir: cmd: [
    "zsh"
    "-c"
    ''
      export PATH=/nix/var/nix/profiles/default/bin:$PATH

      source ${config.home.homeDirectory}/.zshenv
      source ${config.home.homeDirectory}/.zprofile
      source ${config.home.homeDirectory}/.zshrc
      source ${config.home.homeDirectory}/.zlogin

      cd ${dir} && /nix/var/nix/profiles/default/bin/nix-shell --command '${cmd}'
    ''
  ];
  bunDaemonAgent = name: dir: {
    enable = true;
    config = {
      ProgramArguments =
        generateProgramArguments dir "bun run --watch index.ts";
      KeepAlive = true;
      RunAtLoad = true;
      StandardOutPath = "/tmp/${name}.log";
      StandardErrorPath = "/tmp/${name}.error.log";
    };
  };
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
    pkgs.cargo
    pkgs.awscli2
    pkgs.age
    pkgs.spotify
    pkgs.discord
    pkgs.kubectl
    pkgs.postgresql
    pkgs.moreutils
    pkgs.wezterm
    pkgs.tmux
    pkgs.eza
    pkgs.fluxcd
    pkgs.dive
    pkgs.aws-console
    pkgs.age-env
    pkgs.run-http
    pkgs.magic-wormhole-rs
    pkgs.slack-cli
    pkgs.bat
    pkgs.s5cmd
    # pkgs.zed-editor
    pkgs.ncdu
    pkgs.sq
    pkgs.nil
    pkgs.nixpkgs-fmt
    pkgs.git-cola
    pkgs.gitui
    pkgs.lazygit
    pkgs.llm
    pkgs.git-filter-repo
    pkgs.devbox
  ];
  programs.home-manager.enable = true;

  programs.zsh = {
    enable = true;

    initExtraFirst = zshrc;
    initExtra = postzshrc + gitAliases + randomAliases + ageEnvStuff
      + navigationTools + awsTools + completions;

    shellAliases = {
      "reload-home-manager" =
        "zsh -c 'cd ~/projs/configs/home-manager && nix --extra-experimental-features nix-command --extra-experimental-features flakes run home-manager/release-24.05 -- switch --flake ~/projs/configs/home-manager#home --extra-experimental-features nix-command --extra-experimental-features flakes' && zsh";
      "ba" = "bun add";
      "bad" = "bun add --dev";
      "bw" = "bun run --watch";
      "br" = "bun remove";
      "bi" = "bun install";
    };
    oh-my-zsh = { enable = true; };
  };

  programs.tmux = {
    enable = true;
    extraConfig = ''

      set -g default-terminal "xterm-256color"
      set -ga terminal-overrides ",*256col*:Tc"
      set -ga terminal-overrides '*:Ss=\E[%p1%d q:Se=\E[ q'
      set-environment -g COLORTERM "truecolor"

      # Mouse works as expected
      set-option -g mouse on
      # easy-to-remember split pane commands
      bind | split-window -h -c "#{pane_current_path}"
      bind - split-window -v -c "#{pane_current_path}"
      bind c new-window -c "#{pane_current_path}"
    '';
  };

  programs.starship = {
    enable = true;
    settings = { kubernetes.disabled = false; };
  };
  programs.git = {
    enable = true;
    userName = "Adriano";
    userEmail = "jld.adriano@gmail.com";
    extraConfig = { push = { autoSetupRemote = true; }; };
  };
  programs.direnv = {
    enable = true;
    enableZshIntegration = true;
    nix-direnv.enable = true;
  };

  # home.file = {
  #   # ... existing file configurations ...
  #   ".config/atuin/config.toml".text =
  #     builtins.readFile "${configsDir}/atuin-config.toml";
  # };

  home.sessionVariables = { REDITOR = "nvim"; };

  launchd.agents.home-manager-daemon = bunDaemonAgent "home-manager-daemon"
    "${config.home.homeDirectory}/projs/configs/nix-home-manager-daemon/";
}
