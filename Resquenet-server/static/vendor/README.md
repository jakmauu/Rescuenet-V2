# Local vendor assets

The dashboard uses a local, unchanged distribution of **Leaflet 1.9.4**, the same
version previously loaded from the CDN. `leaflet-1.9.4/` contains JS, CSS, supporting
images, optional source map, and the upstream BSD-2-Clause license.

Sources: [official release](https://github.com/Leaflet/Leaflet/releases/tag/v1.9.4),
`https://unpkg.com/leaflet@1.9.4/dist/` (distribution files), and the license in that
official GitHub release. No other runtime UI dependencies are fetched from a CDN.

SHA-256 (unchanged distribution files):

- leaflet.js: `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a`
- leaflet.css: `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6`

This makes the Leaflet library available on the local command network. Map tiles
still use the configured provider, currently OpenStreetMap by default. Tiles may
require internet; GPS markers and local API updates do not depend on tile downloads.
No tiles are bundled, prefetched, or substituted in this redesign.
