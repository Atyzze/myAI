# The calendar server

## On a myAI box

`nix/calendar.nix` sets it all up (`services.myai.calendar.enable`, on by default):

- **Radicale** on `127.0.0.1:5232` only, with the box's vobject patch, `owner_only` rights (each
  account sees only its own calendars), and accounts from an htpasswd file of SHA-512 crypt hashes.
- **Storage**: `/srv/myai/input/calendar/collection-root/<name>/<calendar>/<uid>.ics`, one plain
  iCalendar file per event. The folder belongs to the calendar server alone: the input group and
  the SFTP drop box cannot write it; the backup can read it.
- **nginx**, on the LAN site and on the tailnet alike:
  - `/calendar/` the app (`app/calendar`, published by the update manager), `sw.js` never cached;
  - `/dav/` Radicale (told its prefix with `X-Script-Name`, no caching);
  - `/.well-known/caldav` → `/dav/`, so a phone given only the box's address finds it. Redirects
    are relative, because behind `tailscale serve` nginx sees plain http on port 8080.
- **A first calendar**, "Personal" (events and to-dos), for every account the first time it signs
  in.

### Accounts

```bash
sudo myai-calendar add anna             # asks for the password twice (at least 8 characters)
sudo myai-calendar passwd anna
sudo myai-calendar remove anna          # the calendars stay on disk; adding anna again brings them back
sudo myai-calendar users
sudo myai-calendar import people.txt    # "name password" lines; existing names get the new password
```

The accounts file is `/var/lib/myai/calendar/users` (root:radicale, 0640); Radicale reads it
without a restart. Before the first boot, `myai/calendar-users.txt` on the boot partition does the
same as `import`, and is removed once used, as it holds passwords.

### Backups and restore

The box's backup (`services.myai.backup.target`) copies `input/` and so the calendars, in dated
snapshots. To restore one person's calendars, or everyone's:

```bash
sudo systemctl stop radicale
sudo rsync -a --delete /mnt/backup/<snapshot>/input/calendar/ /srv/myai/input/calendar/
sudo systemctl start radicale
```

Devices then sync to what was restored. Events that were on a device but are not in the restored
calendar are kept on that device as a copy (Settings → Kept on this device) to put back if wanted.
Any calendar can also be saved by hand as one `.ics` file (Settings → ⬇ .ics), and imported again.

## Anywhere else

The app is static files; any web server can serve them from any folder. It talks to the calendar
server on its own site only (its Content-Security-Policy allows nothing else), at `/dav/` unless
the sign-in screen's Server field says another path. Any CalDAV server should do; Radicale is what
it is tested against. An nginx example:

```nginx
location /calendar/ {
    alias /var/www/calendar/;          # the unzipped release
    index index.html;
}
location = /calendar/sw.js {
    alias /var/www/calendar/sw.js;
    add_header Cache-Control "no-cache" always;
}
location /dav/ {
    absolute_redirect off;
    proxy_pass http://127.0.0.1:5232/;
    proxy_set_header X-Script-Name /dav;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
    proxy_pass_header Authorization;
    add_header Cache-Control "no-store" always;
}
location = /.well-known/caldav { absolute_redirect off; return 301 /dav/; }
```

and Radicale with htpasswd accounts and `[rights] type = owner_only`. Serve it over https: browsers
only keep an app for offline use (service worker) on a secure site, and phones want https for a
calendar account.
