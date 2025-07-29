{
  description = "Darwin system configuration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    darwin = {
      url = "github:lnl7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-homebrew = {
      url = "github:zhaofengli/nix-homebrew";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, darwin, nixpkgs, nix-homebrew }: {

    darwinConfigurations."jldadriano" = darwin.lib.darwinSystem {
      system = "aarch64-darwin";
      modules = [ 
        ./darwin.nix
        nix-homebrew.darwinModules.nix-homebrew
        {
          nix-homebrew = {
            enable = true;
            user = "jldadriano";
            autoMigrate = true;
          };
        }
      ];
    };
    
    darwinConfigurations."joaoadriano" = darwin.lib.darwinSystem {
      system = "aarch64-darwin";
      modules = [ 
        ./darwin.nix
        nix-homebrew.darwinModules.nix-homebrew
        {
          nix-homebrew = {
            enable = true;
            user = "joaoadriano";
            autoMigrate = true;
          };
        }
      ];
    };
  };
}
