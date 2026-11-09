# Generic icons for open-in-app targets

The web UI shows an icon for each local application it can open a file in. For the configured application ids (`filemanager`, `cursor`, and `vscode` by default), this bundle serves a generic SVG instead of a missing icon. It answers authenticated GET requests only.

## Sub-features

- `icon-get` returns `200` with `image/svg+xml` and `cache-control: private, max-age=3600` for each configured id.
- `icon-auth` returns `401` or `403` without the web session's authentication.
- `icon-method` returns `405` with `allow: GET` for other methods.
- `icon-other` leaves every other id with the upstream response.

## How to get to it (user POV)

- In the web UI, open a session row's `Session actions for <title>` menu, then `Open in`. The submenu lists the local applications DSH detected, and the browser fetches `/open-in-app/icon/<id>` for each.
- Open `<WEB_ORIGIN>/open-in-app/icon/cursor` in the authenticated browser tab.

## Driving it with dshv

Preconditions:

- `dshv up plugins/dsh-open-in-app-icons` and doctor shows `include:local-open-in-app-icons` active. The manifest allows DSH `0.2.1-rc.3 || 0.2.2-alpha.2 || 0.2.2-rc.1`.

- **Authenticated GET.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor`. `status` is `200`, `contentType` is `image/svg+xml; charset=utf-8`, `cacheControl` is `private, max-age=3600`, and `start` begins with `<svg`.
- **Unauthenticated.** Run `dshv exec "$RUN" -- curl -s -o /dev/null -w '%{http_code}' "$(dshv state "$RUN" webOrigin)/open-in-app/icon/cursor"`. The code is `401`.
- **Wrong method.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor --method POST`. `status` is `405`. `fetch` does not print the `allow` header.
- **Unconfigured id.** Run `dshv web "$RUN" fetch /open-in-app/icon/zed`. When Zed is installed on the machine, `status` is `200` with the upstream `image/png`; otherwise it is an upstream error. Either way it is not the generic SVG.
- **Visible result.** Send one message from the composer so that the Default workspace has a session row. Click `--role button --name "Session actions for"` (the first row matches), then `--role menuitem --name "Open in" --exact`, and run `dshv web "$RUN" screenshot open-in-app-icons/menu.png`. The generic arrow icon shows next to `Cursor` and `VS Code`; other applications keep their own icons. `dshv web "$RUN" fetch /open-in-app/apps` lists the detected ids.

## Gotchas

- The isolated host detects applications from the machine, so the menu shows only what is installed there (on 2026-11-09: Cursor, VS Code, Zed, Ghostty, kitty). When `/open-in-app/apps` lists none of the configured ids, the direct GET still proves the route; report the menu step as unreachable, do not mark it verified.
- The workspace header's `Workspace actions for <name>` menu has no `Open in`. Use a session row or the session header's `More actions` menu.
- The run's browser caches the image for an hour, so a repeated `dshv web fetch` may be served from cache. After changing the config, start a new run instead of fetching again.
