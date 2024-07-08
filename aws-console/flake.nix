{
  description = "A flake for aws-console";

  inputs = { nixpkgs.url = "github:NixOS/nixpkgs"; };

  outputs = { self, nixpkgs }:
    let
      version = "0.0.1";
      owner = "joshdk";
      repo = "aws-console";
      supportedSystems =
        [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in {
      packages = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.stdenv.mkDerivation {
            pname = "aws-console";
            inherit version;

            src = pkgs.fetchFromGitHub {
              owner = owner;
              repo = repo;
              rev = "master";
              sha256 = "sha256-T1H2FGcc53NsnZFy8w3cB61MLjro2vXhcagx32Id16g==";
            };

            buildInputs = [ pkgs.go ];

            buildPhase = ''
              export GOPATH=$(pwd)/go
              export GOCACHE=$(pwd)/.go-cache

              mkdir -p $GOPATH/src/github.com/${owner}
              ln -s $src $GOPATH/src/github.com/${owner}/${repo}
              cd $GOPATH/src/github.com/${owner}/${repo}
              go build -o $TMPDIR/aws-console
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp $TMPDIR/aws-console $out/bin/
            '';

            meta = with pkgs.lib; {
              description = "Command-line tool for accessing AWS console";
              homepage = "https://github.com/joshdk/aws-console";
              license = licenses.mit;
            };
          };
        });
    };
}
