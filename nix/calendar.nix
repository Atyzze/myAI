# The calendar: one CalDAV server (Radicale) on loopback holds everyone's calendars, nginx passes it
# on at /dav/ next to the calendar app at /calendar/, on the LAN site and on the tailnet alike.
#
#   browser (calendar app) ──┐
#   iPhone Calendar ─────────┼─ https ─▶ nginx /dav/ ──http──▶ Radicale 127.0.0.1:5232
#   Android (DAVx⁵) ─────────┘                                    │
#                                                                 ▼
#                                         <root>/input/calendar/collection-root/<name>/<calendar>/*.ics
#
# Every event is a plain .ics file under input/calendar/, so the box's backups (myai-backup copies
# input/ and output/) carry the calendars like everything else. Each person signs in with their own
# account and sees only their own calendars (Radicale's owner_only rights). Accounts are made with
# `myai-calendar add NAME` on the box, or from calendar-users.txt on the boot partition.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption mkIf types;
  cfg = config.services.myai;
  ccfg = cfg.calendar;
  myai = cfg.internal.packages;
  storage = "${cfg.root}/input/calendar";
  usersDir = "${cfg.stateDir}/calendar";
  usersFile = "${usersDir}/users";
  port = 5232;

  # Every account gets one calendar the first time it signs in, so a phone that is connected first
  # has somewhere to put events (and reminders: VTODO, for the iPhone's Reminders app).
  firstCalendar = builtins.toJSON {
    personal = {
      tag = "VCALENDAR";
      "D:displayname" = "Personal";
      "ICAL:calendar-color" = "#4caf50";
      "C:supported-calendar-component-set" = "VEVENT,VTODO";
    };
  };

  # The administrator's tool, pointed at the file this box's Radicale reads.
  calendarTool = pkgs.writeShellApplication {
    name = "myai-calendar";
    text = ''
      export MYAI_CALENDAR_USERS=${usersFile}
      exec ${myai.tools}/bin/myai-calendar "$@"
    '';
  };
  # Redirects stay relative: behind tailscale serve nginx sees plain http on port 8080, and an
  # absolute redirect would send a phone to http://<box>:8080/.
  relativeRedirect = to: {
    return = "301 ${to}";
    extraConfig = "absolute_redirect off;";
  };

  calendarLocations = {
    "= /calendar" = relativeRedirect "/calendar/";
    "/calendar/" = {
      alias = "${cfg.root}/app/calendar/";
      index = "index.html";
    };
    # A new build is found by comparing sw.js; it must never come from a cache.
    "= /calendar/sw.js" = {
      alias = "${cfg.root}/app/calendar/sw.js";
      extraConfig = ''
        add_header Cache-Control "no-cache" always;
      '';
    };
    # Radicale under /dav/: it writes its own links with the prefix it is told (X-Script-Name).
    "/dav/".extraConfig = ''
      absolute_redirect off;
      proxy_pass http://127.0.0.1:${toString port}/;
      proxy_set_header X-Script-Name /dav;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Port $server_port;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Host $host;
      proxy_pass_header Authorization;
      proxy_http_version 1.1;
      proxy_buffering off;
      client_max_body_size 50m;
      add_header Cache-Control "no-store" always;
    '';
    # Phones look here first when given only the box's address.
    "= /.well-known/caldav" = relativeRedirect "/dav/";
    "= /.well-known/carddav" = relativeRedirect "/dav/";
  };
in
{
  options.services.myai.calendar = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        The calendar: a CalDAV server for everyone's calendars at /dav/ and the calendar app at
        /calendar/. Accounts: `myai-calendar add NAME` on the box, or calendar-users.txt
        ("name password" lines) on the boot partition when provisionFromBoot is on.
      '';
    };
  };

  config = mkIf (cfg.enable && ccfg.enable) {
    assertions = [
      {
        assertion = !(lib.any (p: p.input == "calendar") (lib.attrValues cfg.pipelines));
        message = "input/calendar/ holds the calendars; no pipeline may take it as its input.";
      }
    ];

    services.radicale = {
      enable = true;
      package = myai.radicale;
      settings = {
        server = {
          hosts = [ "127.0.0.1:${toString port}" ];
          max_content_length = 50000000;
        };
        auth = {
          type = "htpasswd";
          htpasswd_filename = usersFile;
          htpasswd_encryption = "autodetect";
          realm = "myAI calendar";
          delay = 1;
        };
        rights.type = "owner_only";
        storage = {
          filesystem_folder = storage;
          predefined_collections = firstCalendar;
        };
        web.type = "none";
        logging = {
          level = "warning";
          mask_passwords = true;
        };
      };
    };

    systemd.services.radicale = {
      after = [ "systemd-tmpfiles-setup.service" ];
      # Only nginx on this machine talks to it.
      serviceConfig = {
        IPAddressAllow = "localhost";
        IPAddressDeny = "any";
      };
    };

    # input/calendar belongs to the calendar server alone: not writable by the input group or the
    # SFTP drop box (the ACLs input/ hands down are replaced), readable by the backup.
    systemd.tmpfiles.rules = [
      "d ${usersDir} 0750 root radicale - -"
      "f ${usersFile} 0640 root radicale - -"
      "z ${usersFile} 0640 root radicale - -"
      "d ${storage} 0750 radicale radicale - -"
      "a ${storage} - - - - u::rwx,g::r-x,o::---,group:myai-reader:r-x,mask::r-x,default:user::rwx,default:group::r-x,default:other::---,default:group:myai-reader:r-x,default:mask::r-x"
    ]
    ++ lib.optional (cfg.inputAccess == "group") "a+ ${cfg.root}/input - - - - user:radicale:--x";

    environment.systemPackages = [ calendarTool ];

    # Accounts from the boot partition: calendar-users.txt, "name password" per line. The file holds
    # passwords, so it is removed there once the accounts are made.
    systemd.services.myai-calendar-accounts = mkIf cfg.provisionFromBoot {
      description = "Take calendar accounts from the boot partition";
      wantedBy = [ "multi-user.target" ];
      before = [ "radicale.service" ];
      after = [
        "local-fs.target"
        "systemd-tmpfiles-setup.service"
      ];
      unitConfig.ConditionPathExists = "${cfg.provisionDir}/calendar-users.txt";
      serviceConfig.Type = "oneshot";
      script = ''
        set -eu
        src=${lib.escapeShellArg "${cfg.provisionDir}/calendar-users.txt"}
        ${lib.getExe calendarTool} import "$src"
        rm -f "$src"
        echo "calendar accounts taken from the boot partition, and the file removed there"
      '';
    };

    # The calendar's addresses on both sites: this network's and the tailnet's.
    services.nginx.virtualHosts."myai-loopback".locations = calendarLocations;
    services.nginx.virtualHosts."myai-lan" = mkIf cfg.lan.enable { locations = calendarLocations; };
  };
}
