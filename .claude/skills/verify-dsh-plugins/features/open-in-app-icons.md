# Generic icons for open-in-app targets

The web UI shows an icon for each local application in a session's `Open in` menu. For the configured application ids (`filemanager`, `cursor`, and `vscode` by default), this bundle always serves a generic SVG, even when DSH could extract the application's own icon. Every other id keeps DSH's response. It answers authenticated GET requests only.

## Sub-features

- `icon-get` returns `200` with `image/svg+xml` and `cache-control: private, max-age=3600` for each configured id.
- `icon-auth` returns `401` or `403` without the web session's authentication. This check comes first, so an unauthenticated POST also gets `401`.
- `icon-method` returns `405` with `allow: GET` for other authenticated methods.
- `icon-other` leaves every other id with the upstream response: the native icon, or `404` when DSH has none.

## How to get to it (user POV)

- In the web UI, open a session that has at least one turn, choose `More actions` in its header, then `Open in`. The submenu lists the installed applications, and the browser fetches `/open-in-app/icon/<id>` for each.
- Open `<WEB_ORIGIN>/open-in-app/icon/cursor` in the authenticated browser tab.

## Driving it with dshv

Preconditions:

- `dshv up plugins/dsh-open-in-app-icons` and doctor shows `include:local-open-in-app-icons` active. The manifest allows DSH `0.2.1-rc.3 || 0.2.2-alpha.2 || 0.2.2-rc.1`.

- **Authenticated GET.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor`. `status` is `200`, `contentType` is `image/svg+xml; charset=utf-8`, `cacheControl` is `private, max-age=3600`, and `start` begins with `<svg`. Repeat for `vscode` and `filemanager`.
- **Unauthenticated.** Run `curl -s -o /dev/null -w '%{http_code}' "$(dshv state "$RUN" webOrigin)/open-in-app/icon/cursor"`. The code is `401` or `403`.
- **Wrong method.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor --method POST`. `status` is `405`. `dshv web fetch` does not print the `allow` header.
- **Unconfigured id.** Run `dshv web "$RUN" fetch /open-in-app/apps` to list the detected applications, then fetch one that is not configured, such as `/open-in-app/icon/zed`. It returns DSH's native icon (for example `image/png` with `public, max-age=3600`), or `404` for an id DSH has no icon for.
- **Visible result.** Add a workspace (see [workspace-attach.md](./workspace-attach.md)), send `Say hello` from the composer, then run `dshv web "$RUN" click --role button --name "More actions" --exact` and `dshv web "$RUN" click --role menuitem --name "Open in" --exact`. The submenu has menuitems such as `Cursor` and `VS Code`. Run `dshv web "$RUN" screenshot open-in-app-icons/menu.png`. Configured ids show the generic arrow icon, and unconfigured ones show their own icon.

## Gotchas

- `More actions` exists only in the header of a session with at least one turn. A new draft session has no such button.
- The isolated run still detects the applications installed on the host, so the menu lists them. If the host has none of the configured ids, report the menu step as unreachable; the direct GET still proves the route.
- The run's browser caches the image for an hour, so a repeated `dshv web fetch` may be served from cache. After changing the config, start a new run instead of fetching again.
