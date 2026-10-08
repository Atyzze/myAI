# The three folders every box has, and everything that works on them.
#
#   <root>/app      what runs: the web app, pipeline definitions, models.
#                   Written only by the update manager (user myai-update).
#   <root>/input    where files come in. Written by the myai-input group (or by
#                   everyone, inputAccess = "everyone"); pipelines only read.
#   <root>/output   what came out. Nobody writes here except each pipeline, into
#                   output/<its name>/ only, as its own user. People read.
#
# The rules are enforced by the operating system, not by the programs: file
# ownership and ACLs decide who may write where, and every service runs with
# the whole filesystem read-only except the one folder it owns (systemd
# ProtectSystem=strict + ReadWritePaths). A pipeline cannot reach the network
# beyond this machine. Backups are a plain rsync loop with no AI in it.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkOption
    mkIf
    types
    mapAttrs'
    mapAttrsToList
    nameValuePair
    optional
    optionalAttrs
    ;
  cfg = config.services.myai;
  root = cfg.root;
  myai = cfg.internal.packages;
  pipelines = cfg.pipelines;

  defaultSettings = {
    transcribe = {
      vts_url = "https://127.0.0.1:4444/transcribe";
      ca_file = "${cfg.stateDir}/tls-loopback/cert.pem";
      language = "auto";
      window_seconds = 120;
      search_seconds = 6;
      speaker_threshold = 0.45;
      max_speakers = 8;
      ffmpeg = lib.getExe pkgs.ffmpeg-headless;
    };
  };

  definitionFile =
    name: p:
    pkgs.writeText "pipeline-${name}.json" (
      builtins.toJSON (
        {
          inherit name;
          inherit (p) input processor;
          settings = (defaultSettings.${p.processor} or { }) // p.settings;
        }
        // optionalAttrs (p.extensions != null) { inherit (p) extensions; }
      )
    );

  manifest = pkgs.writeText "manifest.json" (
    builtins.toJSON {
      client_build = myai.client.version;
      calendar_build = myai.calendar.version;
      vts_build = myai.vts.version;
      nixos = config.system.nixos.release;
      accelerators = cfg.accelerators;
      pipelines = builtins.attrNames pipelines;
    }
  );

  readme = pkgs.writeText "README.txt" ''
    This box keeps everything in three folders under ${root}:

      app/     what runs: the web app, pipeline definitions, models.
               Only the update manager writes here.
      input/   put files here. A pipeline tunes into input/<name>/ and only reads.
               input/calendar/ holds everyone's calendars (one .ics file per event);
               only the calendar server writes there.
      output/  results. Each pipeline writes only output/<its name>/; nobody
               else writes here.

    Pipelines (app/pipelines/*.json):
    ${lib.concatStrings (
      mapAttrsToList (n: p: "  ${n}: input/${p.input}/ -> output/${n}/ (${p.processor})\n") pipelines
    )}
    Options for one input file go beside it as <file>.json, for example
    {"language": "nl"}. Events: output/<pipeline>/events.jsonl, as feeds at
    /feeds/events.atom on the tailnet.
  '';

  sandbox = writable: {
    ProtectSystem = "strict";
    ReadWritePaths = writable;
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    NoNewPrivileges = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    RestrictSUIDSGID = true;
    RestrictRealtime = true;
    RestrictNamespaces = true;
    LockPersonality = true;
    RemoveIPC = true;
    SystemCallArchitectures = "native";
    UMask = "0027";
  };

  inputAcl = "group:myai-reader:r-x,default:group:myai-reader:r-x,default:group:myai-input:rwx,default:mask::rwx";
  inputDir =
    path:
    if cfg.inputAccess == "everyone" then
      [ "d ${path} 1777 root root - -" ]
    else
      [
        "d ${path} 2770 root myai-input - -"
        "a+ ${path} - - - - ${inputAcl}"
      ];

  pipelineUser = name: "myai-pipe-${name}";
  emailOn = cfg.email.enable;
  backupOn = cfg.backup.target != null;
in
{
  options.services.myai = {
    root = mkOption {
      type = types.str;
      default = "/srv/myai";
      description = "Where the app, input and output folders live.";
    };

    inputAccess = mkOption {
      type = types.enum [
        "group"
        "everyone"
      ];
      default = "group";
      description = ''
        Who may put files into input/: "group" means members of myai-input
        (and the SFTP drop user); "everyone" means any user on the box.
      '';
    };

    pipelines = mkOption {
      description = ''
        Pipelines, each a data file in app/pipelines/<name>.json. A pipeline
        reads input/<input>/ (and may read other outputs) and writes only
        output/<name>/, as its own user.
      '';
      default = {
        transcribe = {
          processor = "transcribe";
        };
      };
      type = types.attrsOf (
        types.submodule (
          { name, ... }:
          {
            options = {
              input = mkOption {
                type = types.str;
                default = name;
                description = "Subfolder of input/ this pipeline tunes into.";
              };
              processor = mkOption {
                type = types.enum [ "transcribe" ];
                description = "What the pipeline does with each file.";
              };
              extensions = mkOption {
                type = types.nullOr (types.listOf types.str);
                default = null;
                description = "File extensions to take; null for the processor's own list.";
              };
              settings = mkOption {
                type = types.attrsOf types.anything;
                default = { };
                description = "Processor settings, merged over the defaults.";
              };
            };
          }
        )
      );
    };

    email = {
      enable = lib.mkEnableOption "email for the events someone subscribed to";
      to = mkOption {
        type = types.listOf types.str;
        default = [ ];
      };
      from = mkOption {
        type = types.str;
        default = "myai@${config.networking.hostName}";
      };
      kinds = mkOption {
        type = types.listOf types.str;
        default = [
          "failed"
          "report"
        ];
        description = "Event kinds to email (globs allowed), e.g. [ \"*\" ] for everything.";
      };
      pipelines = mkOption {
        type = types.listOf types.str;
        default = [ "*" ];
        description = "Pipelines whose events to email (globs allowed).";
      };
      smtp = {
        host = mkOption { type = types.str; };
        port = mkOption {
          type = types.port;
          default = 587;
        };
        user = mkOption {
          type = types.nullOr types.str;
          default = null;
        };
        passwordFile = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "File holding the SMTP password, readable by user myai-notify.";
        };
      };
    };

    backup = {
      target = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/mnt/backup";
        description = ''
          A mounted folder to back up input/ and output/ to, as dated hard-linked
          snapshots. It must contain a file named .myai-backup-target and be
          writable by user myai-backup, so an unmounted disk fails loudly.
        '';
      };
      keepDays = mkOption {
        type = types.ints.positive;
        default = 30;
      };
      schedule = mkOption {
        type = types.str;
        default = "daily";
        description = "systemd OnCalendar expression.";
      };
    };

    dropUser.enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        An SFTP-only account, myai-drop, that sees exactly the three folders
        (chrooted to ${root}): it may write input/ and read output/. Over the
        tailnet only. Keys: ${cfg.stateDir}/provision/myai-drop.authorized_keys
        (drop_authorized_keys on the boot partition).
      '';
    };
  };

  config = mkIf cfg.enable {
    users.groups = {
      myai-input = { };
      myai-output = { };
      myai-reader = { };
      myai-update = { };
    };
    users.users =
      {
        myai-update = {
          isSystemUser = true;
          group = "myai-update";
          description = "myAI update manager, the only writer of app";
        };
        myai-feeds = {
          isSystemUser = true;
          group = "myai-output";
        };
        nginx.extraGroups = [ "myai-output" ];
      }
      // lib.mapAttrs' (
        name: _:
        nameValuePair (pipelineUser name) {
          isSystemUser = true;
          group = "myai-output";
          extraGroups = [ "myai-reader" ];
          description = "myAI pipeline ${name}";
        }
      ) pipelines
      // optionalAttrs emailOn {
        myai-notify = {
          isSystemUser = true;
          group = "myai-output";
        };
      }
      // optionalAttrs backupOn {
        myai-backup = {
          isSystemUser = true;
          group = "myai-output";
          extraGroups = [ "myai-reader" ];
        };
      }
      // optionalAttrs cfg.dropUser.enable {
        myai-drop = {
          isSystemUser = true;
          group = "myai-input";
          extraGroups = [ "myai-output" ];
          shell = "/run/current-system/sw/bin/nologin";
          home = "/";
          description = "myAI drop box, SFTP, writes input and reads output";
        };
      };

    systemd.tmpfiles.rules = [
      "d ${root} 0755 root root - -"
      "d ${root}/app 0755 myai-update myai-update - -"
      "d ${root}/app/pipelines 0755 myai-update myai-update - -"
      "d ${root}/app/models 0755 myai-update myai-update - -"
      "d ${root}/output 0750 root myai-output - -"
      "d ${root}/output/feeds 2750 myai-feeds myai-output - -"
    ]
    ++ inputDir "${root}/input"
    ++ lib.concatLists (
      mapAttrsToList (
        name: p:
        inputDir "${root}/input/${p.input}"
        ++ [ "d ${root}/output/${name} 2750 ${pipelineUser name} myai-output - -" ]
      ) pipelines
    )
    ++ optional emailOn "d ${root}/output/notify 2750 myai-notify myai-output - -"
    ++ optional backupOn "d ${root}/output/backup 2750 myai-backup myai-output - -";

    # ---- pipelines -------------------------------------------------------------
    systemd.services = lib.mapAttrs' (
      name: p:
      nameValuePair "myai-pipeline-${name}" {
        description = "myAI pipeline ${name}: input/${p.input}/ to output/${name}/";
        after = [
          "myai-app.service"
          "systemd-tmpfiles-setup.service"
        ]
        ++ optional (p.processor == "transcribe") "vts.service";
        serviceConfig = sandbox [ "${root}/output/${name}" ] // {
          Type = "oneshot";
          User = pipelineUser name;
          Group = "myai-output";
          ExecStart = "${myai.tools}/bin/myai-pipeline ${root}/app/pipelines/${name}.json --root ${root}";
          # Audio is decoded in memory; keep it out of swap like VTS does.
          MemorySwapMax = 0;
          LimitCORE = 0;
          # A pipeline talks to this machine only.
          IPAddressDeny = "any";
          IPAddressAllow = "localhost";
          RestrictAddressFamilies = [
            "AF_UNIX"
            "AF_INET"
            "AF_INET6"
          ];
          # Live use of the app comes first.
          Nice = 10;
          IOSchedulingClass = "idle";
        };
      }
    ) pipelines
    // {
      # The update manager: the only writer of app/.
      myai-app = {
      description = "myAI update manager: publish this release into app/";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-tmpfiles-setup.service" ];
      before = [ "nginx.service" ];
      restartTriggers = [
        myai.client
        myai.calendar
        manifest
      ]
      ++ mapAttrsToList definitionFile pipelines;
      serviceConfig = sandbox [ "${root}/app" ] // {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "myai-update";
        Group = "myai-update";
        UMask = "0022";
      };
      script = ''
        set -eu
        app=${root}/app
        swap() { mv -fT "$1" "$2"; }
        ln -sfn ${myai.client} "$app/.client.new" && swap "$app/.client.new" "$app/client"
        ln -sfn ${myai.calendar} "$app/.calendar.new" && swap "$app/.calendar.new" "$app/calendar"
        install -m 0644 ${manifest} "$app/.manifest.new" && swap "$app/.manifest.new" "$app/manifest.json"
        install -m 0644 ${readme} "$app/.readme.new" && swap "$app/.readme.new" "$app/README.txt"
        keep=""
        ${lib.concatStrings (
          mapAttrsToList (name: p: ''
            install -m 0644 ${definitionFile name p} "$app/pipelines/.${name}.new"
            swap "$app/pipelines/.${name}.new" "$app/pipelines/${name}.json"
            keep="$keep ${name}.json"
          '') pipelines
        )}
        for f in "$app"/pipelines/*.json; do
          [ -e "$f" ] || continue
          case " $keep " in *" $(basename "$f") "*) ;; *) rm -f "$f" ;; esac
        done
      '';
    };

      myai-feeds = {
        description = "Atom feeds of every pipeline's events";
        after = [ "systemd-tmpfiles-setup.service" ];
        serviceConfig = sandbox [ "${root}/output/feeds" ] // {
          Type = "oneshot";
          User = "myai-feeds";
          Group = "myai-output";
          ExecStart = "${myai.tools}/bin/myai-feed --root ${root}";
          IPAddressDeny = "any";
          UMask = "0027";
        };
      };
    }
    // optionalAttrs emailOn {
      myai-notify = {
        description = "Email subscribed myAI events";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = sandbox [ "${root}/output/notify" ] // {
          Type = "oneshot";
          User = "myai-notify";
          Group = "myai-output";
          ExecStart = lib.escapeShellArgs (
            [
              "${myai.tools}/bin/myai-notify"
              "--root"
              root
              "--from"
              cfg.email.from
              "--kinds"
              (lib.concatStringsSep "," cfg.email.kinds)
              "--pipelines"
              (lib.concatStringsSep "," cfg.email.pipelines)
              "--sendmail"
              "${pkgs.msmtp}/bin/msmtp"
            ]
            ++ lib.concatMap (to: [
              "--to"
              to
            ]) cfg.email.to
          );
        };
      };
    }
    // optionalAttrs backupOn {
      myai-backup = {
        description = "Back up input/ and output/ (rsync snapshots, no AI)";
        after = [ "local-fs.target" ];
        serviceConfig = sandbox [
          "${root}/output/backup"
          cfg.backup.target
        ] // {
          Type = "oneshot";
          User = "myai-backup";
          Group = "myai-output";
          ExecStart = lib.escapeShellArgs [
            "${myai.tools}/bin/myai-backup"
            "--root"
            root
            "--target"
            cfg.backup.target
            "--keep-days"
            (toString cfg.backup.keepDays)
            "--rsync"
            "${pkgs.rsync}/bin/rsync"
          ];
          IPAddressDeny = "any";
          UMask = "0027";
        };
      };
    };

    systemd.timers =
      lib.mapAttrs' (
        name: _:
        nameValuePair "myai-pipeline-${name}" {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnBootSec = "2min";
            OnUnitInactiveSec = "30s";
          };
        }
      ) pipelines
      // {
        myai-feeds = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnBootSec = "3min";
            OnUnitInactiveSec = "1min";
          };
        };
      }
      // optionalAttrs emailOn {
        myai-notify = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnBootSec = "5min";
            OnUnitInactiveSec = "5min";
          };
        };
      }
      // optionalAttrs backupOn {
        myai-backup = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = cfg.backup.schedule;
            Persistent = true;
            RandomizedDelaySec = "30min";
          };
        };
      };

    # A file closed in a pipeline's input folder starts a run straight away
    # (it still waits until the file has settled); the timer catches the rest.
    systemd.paths = lib.mapAttrs' (
      name: p:
      nameValuePair "myai-pipeline-${name}" {
        wantedBy = [ "paths.target" ];
        pathConfig.PathChanged = "${root}/input/${p.input}";
      }
    ) pipelines;

    programs.msmtp = mkIf emailOn {
      enable = true;
      accounts.default = {
        inherit (cfg.email.smtp) host port;
        from = cfg.email.from;
        tls = true;
        auth = cfg.email.smtp.user != null;
      }
      // optionalAttrs (cfg.email.smtp.user != null) { user = cfg.email.smtp.user; }
      // optionalAttrs (cfg.email.smtp.passwordFile != null) {
        passwordeval = "cat ${cfg.email.smtp.passwordFile}";
      };
    };

    # ---- the SFTP drop box: exactly the three folders ----------------------------
    services.openssh.extraConfig = mkIf cfg.dropUser.enable ''
      Match User myai-drop
        ChrootDirectory ${root}
        ForceCommand internal-sftp -u 0007
        AllowTcpForwarding no
        AllowAgentForwarding no
        X11Forwarding no
        PermitTTY no
    '';

    assertions = [
      {
        assertion = !emailOn || cfg.email.to != [ ];
        message = "services.myai.email.enable needs at least one address in services.myai.email.to.";
      }
      {
        assertion = lib.all (n: builtins.match "[a-z0-9][a-z0-9-]*" n != null) (builtins.attrNames pipelines);
        message = "services.myai.pipelines names must be lowercase letters, digits and dashes.";
      }
      {
        assertion = !(pipelines ? feeds || pipelines ? notify || pipelines ? backup);
        message = "feeds, notify and backup are reserved output folder names.";
      }
    ];
  };
}
