# Responsive pipe evidence

The frozen route capture stored the desktop rendered HTML. The homepage decorative pipe is recalculated by the source runtime for narrower viewports, so its 768 px and 390 px states were captured separately from the same authorized source.

- `pipe-tablet.svg`: source pipe at 768×1000
- `pipe-mobile.svg`: source pipe at 390×844

The builder injects these as inert templates and replaces the desktop pipe at the matching width. No source scripts are retained.
