# Generic icons for open-in-app targets

The web UI shows an icon for each local application it can open a file in. For the configured application ids (`filemanager`, `cursor`, and `vscode` by default), this bundle serves a generic SVG instead of a missing icon. It answers authenticated GET requests only.

## Sub-features

- `icon-get` returns `200` with `image/svg+xml` and `cache-control: private, max-age=3600` for each configured id.
- `icon-auth` returns `401` or `403` without the web session's authentication.
- `icon-method` returns `405` with `allow: GET` for other methods.
- `icon-other` leaves every other id with the upstream response.

## How to get to it (user POV)

- In the web UI, open the right sidebar's `Workspace files` panel for a session in a workspace. Its header has an `Open in <app>` button and a `More ways to open` menu; the browser fetches `/open-in-app/icon/<id>` for every listed application.
- Open `<WEB_ORIGIN>/open-in-app/icon/cursor` in the authenticated browser tab.

## Driving it with dshv

Preconditions:

- `dshv up plugins/dsh-open-in-app-icons` and doctor shows `include:local-open-in-app-icons` active. The manifest allows DSH `0.2.1-rc.3 || 0.2.2-alpha.2 || 0.2.2-rc.1` only.

- **Authenticated GET.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor`. `status` is `200`, `contentType` is `image/svg+xml; charset=utf-8`, `cacheControl` is `private, max-age=3600`, and `start` begins with `<svg`.
- **Unauthenticated.** Run `curl -s -o /dev/null -w '%{http_code}' "$(dshv state "$RUN" webOrigin)/open-in-app/icon/cursor"`. The code is `401` or `403` (`401` on 0.2.2-rc.1).
- **Wrong method.** Run `dshv web "$RUN" fetch /open-in-app/icon/cursor --method POST`. `status` is `405` and `cacheControl` is `no-store`. `dshv web fetch` does not print the `allow` header.
- **Unconfigured id.** Run `dshv web "$RUN" fetch /open-in-app/icon/<some other id>`. The response is the upstream icon (for `zed`, `image/png` with `public, max-age=3600`), not the generic SVG.
- **Visible result.** Add a workspace as in [workspace-attach](./workspace-attach.md) (a directory under the run's `home` with one file in it), then `dshv web "$RUN" click --role button --name "Open right sidebar"`, `click --role button --name "Workspace files"`, and `click --role button --name "More ways to open"`. `dshv web "$RUN" snapshot --role menu` lists menuitems such as `Cursor (default)` and `VS Code`; `dshv web "$RUN" screenshot open-in-app-icons/menu.png` shows the generic arrow icon next to Cursor and VS Code, and the upstream icons next to the other applications.

## Gotchas

- Application detection is not isolated by `dshv`: the menu lists the applications installed on the machine (for example Cursor, VS Code, Zed, Ghostty, kitty), because only `HOME` is isolated. On a machine without Cursor or VS Code the menu may not list them. If neither appears, the direct GET still proves the route; report the menu step as unreachable, not verified.
- The chevron `More ways to open` shows only when more than one application is listed.
- The run's browser caches the image for an hour, so a repeated `dshv web fetch` may be served from cache. After changing the config, start a new run instead of fetching again.
