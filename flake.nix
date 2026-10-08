{
  description = "myAI: private voice notes, live transcription, translation and AI replies on your own box";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};

      # One box definition, three accelerator sets.
      box =
        {
          system,
          accelerators,
          extra ? [ ],
        }:
        lib.nixosSystem {
          inherit system;
          modules = [
            ./nix/box.nix
            {
              services.myai.accelerators = accelerators;
              nixpkgs.config.allowUnfree = builtins.elem "cuda" accelerators;
            }
          ]
          ++ extra;
        };
    in
    {
      nixosModules.default = ./nix/module.nix;
      nixosModules.box = ./nix/box.nix;

      nixosConfigurations = {
        # Universal x86_64 box: NVIDIA through CUDA, any other GPU through
        # Vulkan, otherwise the CPU. CUDA parts build from source once.
        myai-box = box {
          system = "x86_64-linux";
          accelerators = [
            "cuda"
            "vulkan"
          ];
        };
        # No unfree parts, entirely from the binary cache, much smaller:
        # laptops, integrated graphics, AMD/Intel GPUs (AI model via Vulkan).
        myai-box-lite = box {
          system = "x86_64-linux";
          accelerators = [
            "vulkan"
            "igpu"
          ];
        };
        # Raspberry Pi 4/5 class boards: CPU only, SD card image.
        myai-box-arm = box {
          system = "aarch64-linux";
          accelerators = [ ];
          extra = [
            (
              { lib, ... }:
              {
                services.myai.provisionDir = "/boot/firmware/myai";
                fileSystems."/" = lib.mkDefault {
                  device = "/dev/disk/by-label/NIXOS_SD";
                  fsType = "ext4";
                };
                fileSystems."/boot/firmware" = {
                  device = lib.mkDefault "/dev/disk/by-label/FIRMWARE";
                  fsType = lib.mkDefault "vfat";
                  options = lib.mkForce [ "nofail" ];
                };
                boot.loader.grub.enable = false;
                boot.loader.generic-extlinux-compatible.enable = lib.mkDefault true;
                # The SD card base enables ZFS for installers; a box does not need it.
                boot.supportedFilesystems.zfs = lib.mkForce false;
              }
            )
          ];
        };
      };

      packages = forAll (
        system:
        let
          pkgs = pkgsFor system;
          myai = import ./nix/packages.nix {
            inherit pkgs lib;
            accelerators = [ "vulkan" ];
          };
          images = name: self.nixosConfigurations.${name}.config.system.build.images;
        in
        {
          inherit (myai)
            client
            calendar
            radicale
            vts
            probe
            models
            tools
            status
            ;
        }
        // lib.optionalAttrs (system == "x86_64-linux") {
          # dd to a disk or USB stick and boot ("apply"); grows to fill the disk.
          image = (images "myai-box").raw-efi;
          image-lite = (images "myai-box-lite").raw-efi;
          # Try it without installing (nothing persists between boots).
          iso = (images "myai-box").iso;
          iso-lite = (images "myai-box-lite").iso;
          # Virtual machines.
          qcow2 = (images "myai-box").qemu-efi;
          qcow2-lite = (images "myai-box-lite").qemu-efi;
          default = (images "myai-box").raw-efi;
        }
        // lib.optionalAttrs (system == "aarch64-linux") {
          sd-image = (images "myai-box-arm").sd-card;
          default = (images "myai-box-arm").sd-card;
        }
      );

      # `nix run github:Atyzze/myAI#probe`: what would this machine get?
      apps = forAll (system: {
        probe = {
          type = "app";
          program = lib.getExe self.packages.${system}.probe;
        };
        default = self.apps.${system}.probe;
      });

      checks = forAll (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          tests = (import ./nix/packages.nix { inherit pkgs lib; }).checks;
        }
        // lib.optionalAttrs (system == "x86_64-linux") {
          lite-system = self.nixosConfigurations.myai-box-lite.config.system.build.toplevel;
        }
      );

      formatter = forAll (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
