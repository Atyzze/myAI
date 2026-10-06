# A myAI box: the services.myai stack plus what an appliance needs around it.
# Every image variant in flake.nix is this module with a different accelerator
# list; nothing here is tied to one machine.
{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
let
  consoleShell =
    (pkgs.writeShellScriptBin "myai-console" ''
      export PATH=/run/wrappers/bin:/run/current-system/sw/bin:''${PATH:-}
      exec /run/current-system/sw/bin/myai-status --console
    '').overrideAttrs
      { passthru.shellPath = "/bin/myai-console"; };
in
{
  imports = [
    ./module.nix
    "${modulesPath}/profiles/all-hardware.nix"
  ];

  services.myai = {
    enable = true;
    provisionFromBoot = lib.mkDefault true;
  };

  # The disk layout the images create, so that `nixos-rebuild --flake` onto an
  # installed box (an update) describes the same machine. Image builders
  # override these where they differ (the ISO, the SD card).
  fileSystems = lib.mkIf pkgs.stdenv.hostPlatform.isx86_64 {
    "/" = lib.mkDefault {
      device = "/dev/disk/by-label/nixos";
      fsType = "ext4";
      autoResize = true;
    };
    "/boot" = lib.mkDefault {
      device = "/dev/disk/by-label/ESP";
      fsType = "vfat";
    };
  };
  boot.loader.systemd-boot.enable = lib.mkIf pkgs.stdenv.hostPlatform.isx86_64 (lib.mkDefault true);
  boot.growPartition = lib.mkDefault true;

  networking.hostName = lib.mkDefault "myai";
  networking.networkmanager.enable = true;
  boot.loader.efi.canTouchEfiVariables = lib.mkDefault false;

  # Small boxes get compressed swap in RAM for everything except VTS, whose unit
  # forbids swap (MemorySwapMax=0) so request audio never reaches it.
  zramSwap.enable = true;

  # The box's own screen shows its status: hardware plan, models, services, how
  # to reach it, and [L] for a Tailscale login QR code. It is not a shell.
  users.users.myai-console = {
    isNormalUser = true;
    description = "myAI status screen";
    shell = consoleShell;
    hashedPassword = "!";
    # Reads output/ for the per-pipeline counts on the status screen.
    extraGroups = [ "myai-output" ];
  };
  environment.shells = [ consoleShell ];
  services.getty.autologinUser = "myai-console";
  services.getty.helpLine = lib.mkForce "";
  security.sudo.extraRules = [
    {
      users = [ "myai-console" ];
      commands = [
        {
          command = "/run/current-system/sw/bin/tailscale up --qr --timeout=10m";
          options = [ "NOPASSWD" ];
        }
      ];
    }
  ];

  # Administration and the SFTP drop box over the tailnet only (port 22 is not
  # open on the LAN), with keys from the boot partition: myai/authorized_keys
  # for root, myai/drop_authorized_keys for the drop box.
  services.openssh = {
    enable = true;
    openFirewall = false;
    # root.authorized_keys and myai-drop.authorized_keys, from the boot partition.
    authorizedKeysFiles = [ "${config.services.myai.stateDir}/provision/%u.authorized_keys" ];
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  documentation.enable = lib.mkDefault false;
  system.stateVersion = "26.05";
}
