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

    unalias gcv 2>/dev/null
    function gcv() {
      git commit --no-verify $@
    }

    unalias gca 2>/dev/null
    function gca() {
      git commit --amend
    }

    function rebi() {
      git rebase --interactive --autostash HEAD~''${1:-10}
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
    plugins=(git brew kubectl aws bun github npm)

    bindkey -v

  '';
  postzshrc = ''
    eval "$(atuin init zsh)"
  '';

  randomAliases = ''
    #/usr/bin/env zsh

    alias awswho="aws sts get-caller-identity"

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
    pkgs.aws-console
    pkgs.age-env
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
