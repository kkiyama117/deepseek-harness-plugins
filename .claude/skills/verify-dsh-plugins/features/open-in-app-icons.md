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

- **Authenticated GET.** In a script, run `const { page } = await openWeb(WEB_URL)`, then `page.evaluate(() => fetch('/open-in-app/icon/cursor').then(r => [r.status, r.headers.get('content-type'), r.headers.get('cache-control')]))`. The result is `[200, 'image/svg+xml; charset=utf-8', 'private, max-age=3600']`. Save the body as `icon-cursor.svg`.
- **Unauthenticated.** Run `curl -s -o /dev/null -w '%{http_code}' "$WEB_ORIGIN/open-in-app/icon/cursor"` with no cookie. The code is `401` or `403`.
- **Wrong method.** Run `fetch('/open-in-app/icon/cursor', { method: 'POST' })` from the page. The status is `405`.
- **Unconfigured id.** Run `fetch('/open-in-app/icon/<some other id>')` from the page. The status and body differ from the generic SVG.
- **Visible result.** Screenshot the open-in-app menu showing the generic icon next to Cursor or VS Code.

## Gotchas

- Not yet executed with `dshv`. Confirm the menu's accessible names on the first run and record them here.
- The isolated host may list no installed applications, so the menu may not show these ids. The direct GET still proves the route. Report the menu step as unreachable in that case; do not mark it verified.
- Browsers cache the image for an hour. Use a fresh `openWeb` per check.
