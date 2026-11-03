# Generic icons for open-in-app targets

The web UI shows an icon for each local application it can open a file in. For the configured application ids (`filemanager`, `cursor`, and `vscode` by default), this bundle serves a generic SVG instead of a missing icon. It answers authenticated GET requests only.

## Sub-features

- `icon-get` returns `200` with `image/svg+xml` and `cache-control: private, max-age=3600` for each configured id.
- `icon-auth` returns `401` or `403` without the web session's authentication.
- `icon-method` returns `405` with `allow: GET` for other methods.
- `icon-other` leaves every other id with the upstream response.

## How to get to it (user POV)

- In the web UI, open a session's open-in-app menu. The browser fetches `/open-in-app/icon/<id>` for every listed application.
- Open `<WEB_ORIGIN>/open-in-app/icon/cursor` in the authenticated browser tab.

## Driving it with dshv

Preconditions:

- `dshv up plugins/dsh-open-in-app-icons` and doctor shows `include:local-open-in-app-icons` active. The manifest allows DSH `0.2.1-rc.3 || 0.2.2-alpha.2` only.

- **Authenticated GET.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor`. `status` is `200`, `contentType` is `image/svg+xml; charset=utf-8`, `cacheControl` is `private, max-age=3600`, and `start` begins with `<svg`.
- **Unauthenticated.** Run `curl -s -o /dev/null -w '%{http_code}' "$(dshv state "$RUN" webOrigin)/open-in-app/icon/cursor"`. The code is `401` or `403`.
- **Wrong method.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor --method POST`. `status` is `405`.
- **Unconfigured id.** Run `dshv web "$RUN" fetch /open-in-app/icon/<some other id>`. The status or body differs from the generic SVG.
- **Visible result.** Open the open-in-app menu and run `dshv web "$RUN" screenshot open-in-app-icons/menu.png`. The generic icon shows next to Cursor or VS Code.

## Gotchas

- Not yet executed with `dshv`. Confirm the menu's accessible names on the first run and record them here.
- The isolated host may list no installed applications, so the menu may not show these ids. The direct GET still proves the route. Report the menu step as unreachable in that case; do not mark it verified.
- The run's browser caches the image for an hour, so a repeated `dshv web fetch` may be served from cache. After changing the config, start a new run instead of fetching again.
