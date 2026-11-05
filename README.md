# mac-bench

Tests that need a Mac and its apps, driven from the bench VM. First:
**Dorico checks** — send MusicXML from the VM, get back the PDF Dorico
engraves from it, with no one at the Mac.

```
bun run mac-bench dorico horns.musicxml piano-lines.musicxml
ok dorico-runs/20261105-170000/horns.pdf
ok dorico-runs/20261105-170000/piano-lines.pdf
```

Design: [docs/superpowers/specs/2026-11-05-dorico-checks-design.md](docs/superpowers/specs/2026-11-05-dorico-checks-design.md).

## Setting up a Mac

Filled in from the first install.
