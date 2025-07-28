{
  description = "Darwin system configuration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    darwin = {
      url = "github:lnl7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, darwin, nixpkgs, home-manager }: {

    darwinConfigurations."jldadriano" = darwin.lib.darwinSystem {
      system = "aarch64-darwin";
      modules = [
        ./darwin.nix
        home-manager.darwinModules.home-manager
        {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          home-manager.users.jldadriano = import ../home-manager/home.nix {
            inherit (nixpkgs) lib;
            inherit (nixpkgs.legacyPackages.aarch64-darwin) pkgs;
            username = "jldadriano";
            homeDirectory = "/Users/jldadriano";
            shellConfig = {};
            config = {};
          };
        }
      ];
    };
    darwinConfigurations."joaoadriano" = darwin.lib.darwinSystem {
      system = "aarch64-darwin";
      modules = [
        ./darwin.nix
        home-manager.darwinModules.home-manager
        {
          home-manager.useGlobalPkgs = true;
          home-manager.useUserPackages = true;
          home-manager.users.joaoadriano = import ../home-manager/home.nix {
            inherit (nixpkgs) lib;
            inherit (nixpkgs.legacyPackages.aarch64-darwin) pkgs;
            username = "joaoadriano";
            homeDirectory = "/Users/joaoadriano";
            shellConfig = {};
            config = {};
          };
        }
      ];
    };
  };
}
