{
  description = "Home Manager configuration of jldadriano";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    aws-console.url = "path:../aws-console";
    age-env.url = "github:jld-adriano/age-env";
  };

  outputs = { nixpkgs, home-manager, aws-console, age-env, ... }:
    let
      system = "aarch64-darwin";

      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [
          (self: super: {
            age-env = age-env.packages.${system}.default;
            aws-console = aws-console.packages.${system}.default;
          })
        ];
      };
    in {
      homeConfigurations."home" = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;

        modules = [ ./home.nix ];

        # Optionally use extraSpecialArgs
        # to pass through arguments to home.nix
        extraSpecialArgs = { inherit aws-console; };
      };
    };
}
