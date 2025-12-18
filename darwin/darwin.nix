{ config, pkgs, ... }: {
  # =============================================================================
  # Darwin (macOS) System Configuration
  # =============================================================================
  #
  # AEROSPACE WINDOW MANAGER SETUP
  # ------------------------------
  # This config uses AeroSpace as a tiling window manager with a "virtual desktop"
  # system that spans all monitors simultaneously. Adapts to 2 or 3 monitors.
  #
  # Monitors:
  #   1. ED340CU S3 (external)
  #   2. Built-in Retina Display (laptop)
  #   3. DELL S3422DW (external)
  #
  # Virtual Desktops (3 monitors):
  #   VD1: 1,2,3  |  VD2: 4,5,6  |  VD3: 7,8,9  |  VD4: 10,11,12
  #
  # Virtual Desktops (2 monitors):
  #   VD1: 1,2    |  VD2: 3,4    |  VD3: 5,6    |  VD4: 7,8
  #
  # Keybindings:
  #   alt-1/2/3       - Switch all monitors to Virtual Desktop 1/2/3
  #   alt-shift-1-9   - Move window to workspace 1-9 (see grid above)
  #   alt-h/j/k/l     - Focus window left/down/up/right (vim-style)
  #   alt-shift-h/j/k/l - Move window left/down/up/right
  #   alt-f           - Toggle fullscreen
  #   alt-shift-f     - Flatten workspace tree (reset layout to tiles)
  #   alt-b           - Balance window sizes
  #   alt-period      - Focus next monitor
  #   alt-comma       - Focus previous monitor
  #   alt-?           - Show this help
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
      "FelixKratz/formulae/borders"  # Window border highlighting
    ];
    casks = [
      "nikitabobko/tap/aerospace"
    ];
    taps = [
      "nikitabobko/tap"
      "FelixKratz/formulae"
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
        # Start borders for focused window highlighting
        after-startup-command = [
          "exec-and-forget borders active_color=0xffff3333 inactive_color=0x00000000 width=8.0"
        ];
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
          
          # Virtual Desktops - adapts to 2 or 3 monitors
          # 3 monitors: VD1=1,2,3  VD2=4,5,6  VD3=7,8,9  VD4=10,11,12
          # 2 monitors: VD1=1,2    VD2=3,4    VD3=5,6    VD4=7,8
          "alt-1" = "exec-and-forget ~/projs/configs/home-manager/scripts/aero-switch-vd 1";
          "alt-2" = "exec-and-forget ~/projs/configs/home-manager/scripts/aero-switch-vd 2";
          "alt-3" = "exec-and-forget ~/projs/configs/home-manager/scripts/aero-switch-vd 3";
          "alt-4" = "exec-and-forget ~/projs/configs/home-manager/scripts/aero-switch-vd 4";
          
          # Move window to workspace
          # VD1: 1=mon1, 2=mon2, 3=mon3
          # VD2: 4=mon1, 5=mon2, 6=mon3
          # VD3: 7=mon1, 8=mon2, 9=mon3
          "alt-shift-1" = "move-node-to-workspace 1";
          "alt-shift-2" = "move-node-to-workspace 2";
          "alt-shift-3" = "move-node-to-workspace 3";
          "alt-shift-4" = "move-node-to-workspace 4";
          "alt-shift-5" = "move-node-to-workspace 5";
          "alt-shift-6" = "move-node-to-workspace 6";
          "alt-shift-7" = "move-node-to-workspace 7";
          "alt-shift-8" = "move-node-to-workspace 8";
          "alt-shift-9" = "move-node-to-workspace 9";
          
          # Switch focus between monitors
          "alt-period" = "focus-monitor next";
          "alt-comma" = "focus-monitor prev";
          
          # Help
          "alt-shift-slash" = "exec-and-forget ~/projs/configs/home-manager/scripts/aero-help";
        };
        # No force-assignment - script handles workspace placement dynamically
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
