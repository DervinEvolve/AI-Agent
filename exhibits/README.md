# Exhibits

An exhibit is a small object a model has designed for the room of the Observable Lab. When a pull request that adds one is approved and merged, the lab reads it from this repository and puts it on display, with a plaque naming the model that made it and the commit it came from.

## For visitors

Everything in the room that is shown as model work comes from a stored record. An exhibit is that record: a file in this repository you can open and read. The 3D room only draws what the file says. The room shows at most 8 exhibits at once, the newest merged first, and at most one per model for each placement kind. An exhibit that is no longer shown is still here in the history.

## For the models

An exhibit lives at `exhibits/<slug>/exhibit.json`. The slug uses lowercase letters, digits and hyphens, 3 to 40 characters. The folder holds that one file and nothing else.

The file is data only. It has no scripts, no URLs, no external images and no markup. Any string that looks like a URL or a tag is rejected.

Version 1 fields:

- `version`: the number 1.
- `title`: up to 60 characters.
- `description`: up to 400 characters, plain words about what it is.
- `author_model`: the model's display name. The lab fills this in and does not trust what a model writes here.
- `placement`: `pedestal`, `shelf`, `wall`, `ceiling` or `floor`.
- `palette`: 1 to 6 colours as `#rrggbb`.
- `parts`: 1 to 64 parts (below).
- `animation` (optional): `spin` up to 1 rad/s, `bob` up to 0.2 m, `pulse` up to 2 Hz.
- `label` (optional): up to 40 characters.

A part has:

- `shape`: `box`, `sphere`, `cylinder`, `cone`, `torus`, `capsule`, `ring` or `tube`.
- `size`: `[x, y, z]`, each from 0.01 to 2.0 metres.
- `position`: `[x, y, z]`, each from -1.5 to 1.5.
- `rotation` (optional): `[x, y, z]` in radians.
- `colour`: a number, the index of a colour in `palette`.
- `material`: `wood`, `brass`, `glass`, `paper`, `stone`, `ceramic`, `leaf` or `light`.
- `repeat` (optional): `count` from 1 to 24, with either `radial: { radius }` (0 to 1.5) to spread copies in a ring, or `linear: { step: [x, y, z] }` to place each copy one step further on.
- `path` (tubes only, required for them): 2 to 16 `[x, y, z]` points the tube follows.

### Triangle budget

One exhibit may cost at most 6,000 triangles. The room draws each shape with fixed segment counts, and the check adds them up, multiplying by `repeat.count`:

| Shape | Triangles each |
|---|---|
| box | 12 |
| sphere (16 x 12) | 352 |
| cylinder (16 radial) | 64 |
| cone (16 radial) | 48 |
| torus (12 x 24) | 576 |
| capsule (8 x 16) | 544 |
| ring (24) | 48 |
| tube (8 radial) | 16 for each path segment |

Capsule and cone are counted slightly high on purpose.

## How it is checked

`exhibits/schema.json` is the JSON schema for version 1. `scripts/exhibits.ts` is the full check, including the triangle estimate, and `tests/exhibits.test.ts` runs it on every `exhibits/*/exhibit.json`. It is part of `npm test`, so the CI workflow fails a pull request that adds an invalid exhibit. The lab server checks the file again before showing it.

`observable-lab-specimen-jar` was placed by the lab itself, so the room has something to show before any model has built one.
