{ config, pkgs, ... }: {
  # =============================================================================
  # Darwin (macOS) System Configuration
  # =============================================================================
  #
  # AEROSPACE WINDOW MANAGER SETUP
  # ------------------------------
  # This config uses AeroSpace as a tiling window manager with a "virtual desktop"
  # system that spans all 3 monitors simultaneously.
  #
  # Monitors:
  #   1. ED340CU S3 (external)
  #   2. Built-in Retina Display (laptop)
  #   3. DELL S3422DW (external)
  #
  # Virtual Desktops:
  #   Each "virtual desktop" consists of 3 workspaces (one per monitor):
  #
  #   Virtual Desktop 1: workspace 1 (mon1) + workspace 2 (mon2) + workspace 3 (mon3)
  #   Virtual Desktop 2: workspace 4 (mon1) + workspace 5 (mon2) + workspace 6 (mon3)
  #   Virtual Desktop 3: workspace 7 (mon1) + workspace 8 (mon2) + workspace 9 (mon3)
  #
  # Keybindings:
  #   alt-1/2/3     - Switch all monitors to Virtual Desktop 1/2/3
  #   alt-h/j/k/l   - Focus window left/down/up/right (vim-style)
  #   alt-shift-h/j/k/l - Move window left/down/up/right
  #   alt-f         - Toggle fullscreen
  #   alt-shift-f   - Flatten workspace tree (reset layout)
  #   alt-b         - Balance window sizes
  #   alt-period    - Focus next monitor
  #   alt-comma     - Focus previous monitor
  #
  # =============================================================================

  # Basic configuration
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  
  # Set primary user for user-specific settings
  system.primaryUser = "joaoadriano";
  
  # Fix nixbld group ID for existing Nix installation
  ids.gids.nixbld = 350;

  # Homebrew configuration
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
    brews = [
      "age-plugin-se"
    ];
    casks = [
      "nikitabobko/tap/aerospace"
    ];
    taps = [
      "nikitabobko/tap"
    ];
  };

  # System-wide packages
  environment.systemPackages = with pkgs; [
    # CLI tools
    coreutils
    gnused
    gawk

    # Development tools
    xcode-install
  ];

  # System settings
  system = {
    # System version
    stateVersion = 4;

    defaults = {
      # Dock settings
      dock = {
        autohide = true;
        orientation = "bottom";
        showhidden = true;
        mineffect = "scale";
        launchanim = true;
        show-process-indicators = true;
        tilesize = 48;
        static-only = true;
        mru-spaces = false;
      };

      # Finder settings
      finder = {
        AppleShowAllExtensions = true;
        FXEnableExtensionChangeWarning = false;
        _FXShowPosixPathInTitle = true;
        ShowPathbar = true;
        ShowStatusBar = true;
      };

      # Global settings
      NSGlobalDomain = {
        AppleShowAllExtensions = true;
        InitialKeyRepeat = 15;
        KeyRepeat = 2;
        NSAutomaticCapitalizationEnabled = false;
        NSAutomaticDashSubstitutionEnabled = false;
        NSAutomaticPeriodSubstitutionEnabled = false;
        NSAutomaticQuoteSubstitutionEnabled = false;
        NSAutomaticSpellingCorrectionEnabled = false;
        NSNavPanelExpandedStateForSaveMode = true;
        NSNavPanelExpandedStateForSaveMode2 = true;
        PMPrintingExpandedStateForPrint = true;
        PMPrintingExpandedStateForPrint2 = true;
      };

      # Trackpad settings
      trackpad = {
        Clicking = true;
        TrackpadThreeFingerDrag = true;
      };
    };

    keyboard = {
      enableKeyMapping = true;
      remapCapsLockToEscape = true;
    };
  };

  # Fonts
  fonts = {
    packages = with pkgs; [
      nerd-fonts.fira-code
      nerd-fonts.droid-sans-mono
    ];
  };

  # macOS-specific services
  services = {
    # AeroSpace window manager
    aerospace = {
      enable = true;
      settings = {
        on-focused-monitor-changed = [ "move-mouse monitor-lazy-center" ];
        mode.main.binding = {
          # Vim-style navigation between windows
          "alt-h" = "focus --boundaries-action wrap-around-the-workspace left";
          "alt-j" = "focus --boundaries-action wrap-around-the-workspace down";
          "alt-k" = "focus --boundaries-action wrap-around-the-workspace up";
          "alt-l" = "focus --boundaries-action wrap-around-the-workspace right";
          
          # Move windows
          "alt-shift-h" = "move left";
          "alt-shift-j" = "move down";
          "alt-shift-k" = "move up";
          "alt-shift-l" = "move right";
          
          # Fullscreen
          "alt-f" = "fullscreen";
          
          # Layout reset
          "alt-shift-f" = ["flatten-workspace-tree" "layout tiles" "balance-sizes"];
          "alt-b" = "balance-sizes";
          
          # Virtual Desktop 1: workspaces 1,2,3 across monitors 1,2,3
          # Virtual Desktop 2: workspaces 4,5,6 across monitors 1,2,3
          # Virtual Desktop 3: workspaces 7,8,9 across monitors 1,2,3
          "alt-1" = [
            "summon-workspace 1"
            "focus-monitor 2" "summon-workspace 2"
            "focus-monitor 3" "summon-workspace 3"
            "focus-monitor 1"
          ];
          "alt-2" = [
            "summon-workspace 4"
            "focus-monitor 2" "summon-workspace 5"
            "focus-monitor 3" "summon-workspace 6"
            "focus-monitor 1"
          ];
          "alt-3" = [
            "summon-workspace 7"
            "focus-monitor 2" "summon-workspace 8"
            "focus-monitor 3" "summon-workspace 9"
            "focus-monitor 1"
          ];
          
          # Move window to workspace (on current monitor)
          "alt-shift-1" = "move-node-to-workspace 1";
          "alt-shift-2" = "move-node-to-workspace 4";
          "alt-shift-3" = "move-node-to-workspace 7";
          
          # Switch focus between monitors
          "alt-period" = "focus-monitor next";
          "alt-comma" = "focus-monitor prev";
        };
        # Pin workspaces to monitors
        # Monitor 1: ED340CU S3, Monitor 2: Built-in Retina Display, Monitor 3: DELL S3422DW
        workspace-to-monitor-force-assignment = {
          "1" = "ED340CU S3";      # Virtual Desktop 1
          "2" = "Built-in Retina Display";
          "3" = "DELL S3422DW";
          "4" = "ED340CU S3";      # Virtual Desktop 2
          "5" = "Built-in Retina Display";
          "6" = "DELL S3422DW";
          "7" = "ED340CU S3";      # Virtual Desktop 3
          "8" = "Built-in Retina Display";
          "9" = "DELL S3422DW";
        };
      };
    };
    
    # Yabai window manager
    yabai = {
      enable = false;
      package = pkgs.yabai;
      enableScriptingAddition = true;
      config = {
        layout = "bsp";
        auto_balance = "on";
        split_ratio = 0.5;
        window_placement = "second_child";
        focus_follows_mouse = "autoraise";
        mouse_follows_focus = "off";
        top_padding = 10;
        bottom_padding = 10;
        left_padding = 10;
        right_padding = 10;
        window_gap = 10;
      };
    };

    # skhd - hotkey daemon
    skhd = {
      enable = false;
      package = pkgs.skhd;
      skhdConfig = ''
        # Navigation
        alt - h : yabai -m window --focus west
        alt - j : yabai -m window --focus south
        alt - k : yabai -m window --focus north
        alt - l : yabai -m window --focus east

        # Moving windows
        shift + alt - h : yabai -m window --warp west
        shift + alt - j : yabai -m window --warp south
        shift + alt - k : yabai -m window --warp north
        shift + alt - l : yabai -m window --warp east

        # Resize windows
        lctrl + alt - h : yabai -m window --resize left:-50:0; \
                         yabai -m window --resize right:-50:0
        lctrl + alt - j : yabai -m window --resize bottom:0:50; \
                         yabai -m window --resize top:0:50
        lctrl + alt - k : yabai -m window --resize top:0:-50; \
                         yabai -m window --resize bottom:0:-50
        lctrl + alt - l : yabai -m window --resize right:50:0; \
                         yabai -m window --resize left:50:0

        # Toggle window properties
        shift + alt - f : yabai -m window --toggle zoom-fullscreen
        shift + alt - t : yabai -m window --toggle float
      '';
    };
  };

  # System security
  security.pam.services.sudo_local.touchIdAuth = true;
}
