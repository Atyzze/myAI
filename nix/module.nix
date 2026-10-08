# services.myai: the whole myAI stack on one NixOS machine.
#
#   browser ──https──▶ tailscale serve (anywhere) ─┐
#   browser ──https──▶ nginx :443 (this network) ──┼─▶ nginx :8080 (loopback)
#                                                  │     /             the PWA
#                                                  │     /capabilities what this box can take
#                                                  │     /transcribe   ─https▶ VTS 127.0.0.1:4444
#                                                  │     /ollama/      ─http─▶ Ollama 127.0.0.1:11434
#                                                  │     /calendar/    the calendar app
#                                                  │     /dav/         ─http─▶ Radicale 127.0.0.1:5232
#
# The calendar (calendar.nix) is the one part that keeps data for people across devices: their
# calendars live on the box, in input/calendar/, and phones' own calendar apps use /dav/ too.
#
# At boot myai-probe measures the hardware and writes /run/myai/*: the Whisper
# model/device for VTS, the Ollama backend, the models to fetch, and the limits
# the browser reads. myai-models fetches what is missing. Nothing listens on a
# public interface except nginx on the LAN (optional) and Tailscale.
#
# Data lives in three folders (folders.nix): app/ (what runs, written only by
# the update manager), input/ (files come in) and output/ (each pipeline writes
# only its own subfolder). Over the tailnet nginx also serves /output/ and
# /feeds/ read-only.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkOption
    mkIf
    mkDefault
    types
    optional
    optionals
    ;
  cfg = config.services.myai;
  state = cfg.stateDir;
  provision = "${state}/provision";

  myai = import ./packages.nix {
    inherit pkgs lib;
    inherit (cfg) accelerators;
    diarization = cfg.diarization != false;
  };

  overrides = pkgs.writeText "myai-overrides.json" (
    builtins.toJSON (
      lib.filterAttrs (_: v: v != null) {
        inherit (cfg) accelerators;
        whisper_model = cfg.whisperModel;
        llm_model = cfg.llmModel;
        inherit (cfg) diarization;
      }
    )
  );

  loopbackTls = "${state}/tls-loopback";
  lanTls = "${state}/tls-lan";

  selfSigned =
    {
      dir,
      cn,
      san,
      owner,
    }:
    ''
      set -eu
      mkdir -p ${dir}
      if [ ! -s ${dir}/cert.pem ] || [ ! -s ${dir}/key.pem ]; then
        ${lib.getExe pkgs.openssl} req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
          -nodes -days 3650 -subj "/CN=${cn}" -addext "subjectAltName=${san}" \
          -keyout ${dir}/key.pem -out ${dir}/cert.pem
      fi
      chown ${owner} ${dir}/key.pem
      chmod 0600 ${dir}/key.pem
      chmod 0644 ${dir}/cert.pem
    '';

  appRoot = "${cfg.root}/app/client";

  appLocations = {
    "/" = {
      root = appRoot;
      index = "index.html";
    };
    # The browser finds a new build by comparing sw.js; never let it be cached.
    "= /sw.js" = {
      root = appRoot;
      extraConfig = ''
        add_header Cache-Control "no-cache" always;
      '';
    };
    "= /capabilities" = {
      alias = "/run/myai/capabilities.json";
      extraConfig = ''
        default_type application/json;
        add_header Cache-Control "no-store" always;
      '';
    };
    # Mirrors vts/deploy/nginx.conf.example: request bodies and transcripts stay
    # in memory, never in an nginx temp file.
    "= /transcribe".extraConfig = ''
      client_max_body_size 8m;
      client_body_buffer_size 9m;
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_max_temp_file_size 0;
      proxy_no_cache 1;
      proxy_cache_bypass 1;
      proxy_read_timeout 300s;
      proxy_ssl_verify on;
      proxy_ssl_trusted_certificate ${loopbackTls}/cert.pem;
      proxy_ssl_name 127.0.0.1;
      proxy_pass https://127.0.0.1:4444/transcribe;
      add_header Cache-Control "no-store" always;
    '';
    "= /healthz".extraConfig = ''
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_ssl_verify on;
      proxy_ssl_trusted_certificate ${loopbackTls}/cert.pem;
      proxy_ssl_name 127.0.0.1;
      proxy_pass https://127.0.0.1:4444/healthz;
      add_header Cache-Control "no-store" always;
    '';
    # Ollama refuses browser origins and unknown Host headers by design; the
    # browser talks to nginx, and nginx talks to Ollama as a local client.
    "/ollama/".extraConfig = ''
      client_max_body_size 16m;
      client_body_buffer_size 16m;
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_max_temp_file_size 0;
      proxy_read_timeout 900s;
      proxy_send_timeout 900s;
      proxy_set_header Host "localhost:11434";
      proxy_set_header Origin "";
      proxy_pass http://127.0.0.1:11434/;
      add_header Cache-Control "no-store" always;
    '';
  };
  # Read-only views of output/, for devices on the tailnet only (the LAN site
  # serves just the app). Dot files (.state, .lock, partial writes) stay hidden.
  tailnetLocations = appLocations // {
    "/output/" = {
      alias = "${cfg.root}/output/";
      extraConfig = ''
        autoindex on;
        charset utf-8;
        types { text/plain txt srt jsonl log; application/json json; application/atom+xml atom; }
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        location ~ /\. { deny all; }
      '';
    };
    "/feeds/" = {
      alias = "${cfg.root}/output/feeds/";
      extraConfig = ''
        types { application/atom+xml atom; }
        add_header Cache-Control "no-cache" always;
      '';
    };
  };
in
{
  imports = [
    ./folders.nix
    ./calendar.nix
  ];

  options.services.myai = {
    enable = mkEnableOption "the myAI stack (voice-note app, VTS transcription, Ollama)";

    internal.packages = mkOption {
      type = types.attrsOf types.anything;
      internal = true;
      readOnly = true;
      description = "The myAI packages built for this machine's accelerators.";
    };

    accelerators = mkOption {
      type = types.listOf (
        types.enum [
          "cuda"
          "rocm"
          "vulkan"
          "igpu"
        ]
      );
      default = [ "vulkan" ];
      example = [
        "cuda"
        "vulkan"
      ];
      description = ''
        GPU stacks the image carries; the probe picks among them at boot and
        falls back to the CPU, so a box always runs. "cuda": NVIDIA (Whisper and
        the AI model; unfree, builds from source once). "rocm": AMD through ROCm
        (large). "vulkan": the AI model on any GPU with a Vulkan driver (NVIDIA,
        AMD, Intel Arc). "igpu": also try Vulkan on integrated graphics.
      '';
    };

    whisperModel = mkOption {
      type = types.nullOr (
        types.enum [
          "tiny"
          "base"
          "small"
          "medium"
          "large-v3-turbo"
        ]
      );
      default = null;
      description = "Force a Whisper model instead of the probe's choice.";
    };

    llmModel = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "qwen3:8b";
      description = "Force an Ollama model instead of the probe's choice.";
    };

    diarization = mkOption {
      type = types.nullOr types.bool;
      default = null;
      description = "Speaker embeddings. null: on when the box has 6 GiB of RAM or more.";
    };

    extraModels = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "More Ollama models to pull besides the planned one.";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/myai";
      description = "Models, generated certificates and provisioning files.";
    };

    lan.enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Serve the app on this network at https://<ip> and https://<hostname>.local
        with a self-signed certificate (ports 80 and 443). Off: Tailscale only.
      '';
    };

    tailscale.enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Join a tailnet and publish the app there with a real certificate
        (tailscale serve), so phones reach it from anywhere, privately. Log in
        once from the box's screen ([L]) or with ${provision}/tailscale-authkey.
      '';
    };

    provisionDir = mkOption {
      type = types.str;
      default = "/boot/myai";
      description = "Where provisionFromBoot looks for files.";
    };

    provisionFromBoot = mkOption {
      type = types.bool;
      default = false;
      description = ''
        At boot, take provisioning files from provisionDir (on the images: the
        FAT boot partition, which any computer can open after flashing):
        tailscale-authkey.txt, wifi.txt (ssid= and password= lines),
        authorized_keys (root), drop_authorized_keys (the SFTP drop box),
        calendar-users.txt (calendar accounts, "name password" lines),
        overrides.json. Secrets (the auth key, the Wi-Fi password and the
        calendar passwords) are removed from the boot partition once used.
      '';
    };
  };

  config = mkIf cfg.enable {
    services.myai.internal.packages = myai;

    users.groups.myai = { };
    users.users.myai-vts = {
      isSystemUser = true;
      group = "myai";
      extraGroups = [
        "video"
        "render"
      ];
    };

    systemd.tmpfiles.rules = [
      "d ${state} 0755 root root - -"
      # Traversable but not listable: sshd reads <user>.authorized_keys as that user.
      "d ${provision} 0711 root root - -"
    ];

    environment.etc."myai/lan-enabled" = mkIf cfg.lan.enable { text = "1\n"; };
    environment.systemPackages = [
      myai.status
      myai.probe
      myai.ollama
    ];

    # ---- provisioning from the boot partition --------------------------------
    systemd.services.myai-provision = mkIf cfg.provisionFromBoot {
      description = "Take myAI provisioning files from the boot partition";
      wantedBy = [ "multi-user.target" ];
      before = [
        "myai-probe.service"
        "tailscaled-autoconnect.service"
        "sshd.service"
        "NetworkManager.service"
      ];
      after = [ "local-fs.target" ];
      unitConfig.ConditionPathIsDirectory = cfg.provisionDir;
      serviceConfig.Type = "oneshot";
      path = [ pkgs.coreutils pkgs.gnused ];
      script = ''
        set -eu
        src=${lib.escapeShellArg cfg.provisionDir}
        dst=${provision}
        install -d -m 0711 "$dst"
        [ -s "$src/authorized_keys" ] && install -m 0600 "$src/authorized_keys" "$dst/root.authorized_keys"
        [ -s "$src/drop_authorized_keys" ] && install -m 0644 "$src/drop_authorized_keys" "$dst/myai-drop.authorized_keys"
        [ -s "$src/overrides.json" ] && install -m 0600 "$src/overrides.json" "$dst/overrides.json"
        if [ -s "$src/tailscale-authkey.txt" ]; then
          tr -d ' \r\n' < "$src/tailscale-authkey.txt" > "$dst/tailscale-authkey"
          chmod 0600 "$dst/tailscale-authkey"
          rm -f "$src/tailscale-authkey.txt"
          echo "tailscale auth key taken from the boot partition and removed there"
        fi
        if [ -s "$src/wifi.txt" ] && [ -d /etc/NetworkManager ]; then
          ssid=$(sed -n 's/^ssid=//p' "$src/wifi.txt" | head -1 | tr -d '\r')
          psk=$(sed -n 's/^password=//p' "$src/wifi.txt" | head -1 | tr -d '\r')
          if [ -n "$ssid" ]; then
            conn=/etc/NetworkManager/system-connections/myai-wifi.nmconnection
            install -d -m 0700 /etc/NetworkManager/system-connections
            umask 077
            {
              printf '[connection]\nid=myai-wifi\ntype=wifi\nautoconnect=true\n\n'
              printf '[wifi]\nmode=infrastructure\nssid=%s\n\n' "$ssid"
              if [ -n "$psk" ]; then printf '[wifi-security]\nkey-mgmt=wpa-psk\npsk=%s\n\n' "$psk"; fi
              printf '[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n'
            } > "$conn"
            rm -f "$src/wifi.txt"
            echo "Wi-Fi network $ssid configured from the boot partition and removed there"
          fi
        fi
      '';
    };

    # ---- hardware probe ------------------------------------------------------
    systemd.services.myai-probe = {
      description = "Measure this box and plan models and limits";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-modules-load.service" ];
      before = [
        "vts.service"
        "ollama.service"
        "nginx.service"
        "myai-models.service"
      ];
      path = optional (builtins.elem "cuda" cfg.accelerators) config.hardware.nvidia.package.bin;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        RuntimeDirectory = "myai";
        RuntimeDirectoryMode = "0755";
        RuntimeDirectoryPreserve = "yes";
        ExecStart = lib.escapeShellArgs [
          (lib.getExe myai.probe)
          "--write"
          "/run/myai"
          "--model-root"
          "${cfg.root}/app/models"
          "--overrides"
          "${overrides}"
          "--overrides"
          "${provision}/overrides.json"
        ];
      };
    };

    # ---- models --------------------------------------------------------------
    systemd.services.myai-models = {
      description = "Fetch the models myai-probe planned (first boot needs internet)";
      wantedBy = [ "multi-user.target" ];
      wants = [
        "network-online.target"
        "ollama.service"
      ];
      after = [
        "network-online.target"
        "myai-probe.service"
        "ollama.service"
        "systemd-tmpfiles-setup.service"
      ];
      requires = [ "myai-probe.service" ];
      environment = {
        OLLAMA_HOST = "127.0.0.1:11434";
        HF_HOME = "${cfg.root}/app/models/.hf";
        HF_HUB_DISABLE_TELEMETRY = "1";
      };
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        # Models are part of app/, so the update manager fetches them.
        User = "myai-update";
        Group = "myai-update";
        Restart = "on-failure";
        RestartSec = 60;
        ExecStart = lib.escapeShellArgs [
          (lib.getExe myai.models)
          "--model-root"
          "${cfg.root}/app/models"
          "--state"
          "${cfg.root}/app/models/status.json"
          "--ollama"
          (lib.getExe myai.ollama)
        ];
        ProtectSystem = "strict";
        ReadWritePaths = [ "${cfg.root}/app/models" ];
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
      };
    };

    # ---- VTS -----------------------------------------------------------------
    systemd.services.myai-loopback-tls = {
      description = "Certificate for the nginx to VTS hop on loopback";
      before = [
        "vts.service"
        "nginx.service"
      ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = selfSigned {
        dir = loopbackTls;
        cn = "127.0.0.1";
        san = "IP:127.0.0.1";
        owner = "myai-vts:myai";
      };
    };

    systemd.services.vts = {
      description = "VTS: in-memory Whisper transcription";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network.target"
        "myai-probe.service"
        "myai-loopback-tls.service"
        "myai-models.service"
      ];
      requires = [
        "myai-probe.service"
        "myai-loopback-tls.service"
      ];
      wants = [ "myai-models.service" ];
      environment = {
        VTS_BIND_HOST = "127.0.0.1";
        VTS_BIND_PORT = "4444";
        VTS_TLS_ENABLED = "1";
        TLS_CERT = "${loopbackTls}/cert.pem";
        TLS_KEY = "${loopbackTls}/key.pem";
        RAM_TMP_DIR = "/run/vts";
        TMPDIR = "/run/vts";
        TMP = "/run/vts";
        TEMP = "/run/vts";
        XDG_CACHE_HOME = "/run/vts";
        HF_HUB_OFFLINE = "1";
        TRANSFORMERS_OFFLINE = "1";
        HF_HUB_DISABLE_TELEMETRY = "1";
        CUDA_CACHE_DISABLE = "1";
      };
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        EnvironmentFile = "/run/myai/vts.env";
        ExecStart = lib.getExe myai.vts;
        User = "myai-vts";
        Group = "myai";
        RuntimeDirectory = "vts";
        RuntimeDirectoryMode = "0700";
        Restart = "always";
        RestartSec = 10;
        KillSignal = "SIGINT";
        TimeoutStopSec = 30;
        # Same privacy boundary as the unit vts/install.py writes: request
        # content may live in process memory, not in swap, core dumps, temp
        # files or a writable tree.
        MemorySwapMax = 0;
        LimitCORE = 0;
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        LockPersonality = true;
        RemoveIPC = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
      };
    };

    # ---- Ollama --------------------------------------------------------------
    services.ollama = {
      enable = true;
      package = myai.ollama;
      host = "127.0.0.1";
      port = 11434;
      loadModels = cfg.extraModels;
    };
    systemd.services.ollama = {
      after = [ "myai-probe.service" ];
      requires = [ "myai-probe.service" ];
      serviceConfig.EnvironmentFile = "/run/myai/ollama.env";
    };

    # ---- GPUs ----------------------------------------------------------------
    hardware.graphics.enable = mkDefault true;
    hardware.enableRedistributableFirmware = mkDefault true;
    services.xserver.videoDrivers = mkIf (builtins.elem "cuda" cfg.accelerators) [ "nvidia" ];
    hardware.nvidia = mkIf (builtins.elem "cuda" cfg.accelerators) {
      # Open kernel modules cover Turing (GTX 16xx / RTX 20xx) and newer, and
      # are the only ones Blackwell (RTX 50xx) supports. Set false for Pascal
      # and Maxwell cards (GTX 9xx/10xx).
      open = mkDefault true;
      nvidiaPersistenced = mkDefault true;
    };

    # ---- web -----------------------------------------------------------------
    systemd.services.myai-lan-tls = mkIf cfg.lan.enable {
      description = "Self-signed certificate for the app on this network";
      before = [ "nginx.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = selfSigned {
        dir = lanTls;
        cn = config.networking.hostName;
        san = "DNS:${config.networking.hostName},DNS:${config.networking.hostName}.local";
        owner = "nginx:nginx";
      };
    };

    services.nginx = {
      enable = true;
      recommendedTlsSettings = true;
      recommendedOptimisation = true;
      recommendedGzipSettings = true;
      serverTokens = false;
      virtualHosts = {
        "myai-loopback" = {
          listen = [
            {
              addr = "127.0.0.1";
              port = 8080;
            }
          ];
          locations = tailnetLocations;
        };
      }
      // lib.optionalAttrs cfg.lan.enable {
        "myai-lan" = {
          default = true;
          serverName = config.networking.hostName;
          serverAliases = [ "${config.networking.hostName}.local" ];
          listen = [
            {
              addr = "0.0.0.0";
              port = 443;
              ssl = true;
            }
            {
              addr = "[::]";
              port = 443;
              ssl = true;
            }
            {
              addr = "0.0.0.0";
              port = 80;
            }
            {
              addr = "[::]";
              port = 80;
            }
          ];
          addSSL = true;
          sslCertificate = "${lanTls}/cert.pem";
          sslCertificateKey = "${lanTls}/key.pem";
          extraConfig = ''
            if ($scheme = http) { return 301 https://$host$request_uri; }
          '';
          locations = appLocations;
        };
      };
    };
    systemd.services.nginx = {
      after = [
        "myai-loopback-tls.service"
        "myai-probe.service"
        "myai-app.service"
      ]
      ++ optional cfg.lan.enable "myai-lan-tls.service";
      requires = [ "myai-loopback-tls.service" ] ++ optional cfg.lan.enable "myai-lan-tls.service";
    };

    services.avahi = mkIf cfg.lan.enable {
      enable = mkDefault true;
      nssmdns4 = mkDefault true;
      publish = {
        enable = mkDefault true;
        addresses = mkDefault true;
      };
    };

    # ---- Tailscale -------------------------------------------------------------
    services.tailscale = mkIf cfg.tailscale.enable {
      enable = true;
      openFirewall = true;
      authKeyFile = mkDefault "${provision}/tailscale-authkey";
    };
    systemd.services.tailscaled-autoconnect = mkIf (cfg.tailscale.enable && config.services.tailscale.authKeyFile != null) {
      unitConfig.ConditionPathExists = config.services.tailscale.authKeyFile;
    };
    systemd.services.myai-tailscale-serve = mkIf cfg.tailscale.enable {
      description = "Publish the app on the tailnet with HTTPS";
      wantedBy = [ "multi-user.target" ];
      after = [
        "tailscaled.service"
        "nginx.service"
      ];
      wants = [ "tailscaled.service" ];
      path = [
        config.services.tailscale.package
        pkgs.jq
      ];
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Restart = "on-failure";
        RestartSec = 30;
      };
      # Until someone logs the box in this fails and retries every 30 s;
      # once logged in, tailscale remembers the serve config across reboots.
      script = ''
        set -eu
        state=$(tailscale status --json --peers=false | jq -r '.BackendState')
        if [ "$state" != "Running" ]; then
          echo "tailscale is $state; waiting for a login"
          exit 1
        fi
        tailscale serve --bg --https=443 http://127.0.0.1:8080
      '';
    };
    networking.firewall = {
      enable = true;
      trustedInterfaces = optionals cfg.tailscale.enable [ config.services.tailscale.interfaceName ];
      allowedTCPPorts = optionals cfg.lan.enable [
        80
        443
      ];
      allowedUDPPorts = optionals cfg.lan.enable [ 5353 ];
    };
  };
}
