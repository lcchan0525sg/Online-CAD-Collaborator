# CAD Viewer v0.98 translation workflow

The viewer ships with a built-in English catalog in `src/ui-english.js`. Chinese
locale files are deliberately **not** source-controlled: they are external,
human-reviewed release inputs.

## Source vocabulary

The source vocabulary is maintained outside this repository:

`C:/Users/chan_/Projects/cad-viewer-ui-v0.98-vocabulary.json`

It records stable keys, English fallback text, source references, placeholder
rules, and whether an entry is translatable. When a new visible or runtime UI
string is found, add it there first, then regenerate `src/ui-english.js` from the
catalog source.

## Locale file format

`zh-Hant.json` and `zh-Hans.json` must contain:

```json
{
  "locale": "zh-Hant",
  "displayName": "繁體中文",
  "viewerVersion": "0.98",
  "humanReviewed": true,
  "strings": {
    "ui.about": "關於"
  }
}
```

The validator requires every translatable catalog key, rejects unknown keys, and
checks that named placeholders such as `{count}` are preserved exactly.
`humanReviewed` must be `true` before the portable builder will package a file.

## Validate locale files

```bash
CAD_LANGUAGE_SOURCE="C:/path/to/reviewed-locales" npm run validate-language
```

or validate one file directly:

```bash
node tools/validate-language.mjs C:/path/to/zh-Hant.json
```

## Run with external locales in development

```bash
CAD_LANGUAGE_DIR="C:/path/to/locales" npm start
```

The server exposes only safe, read-only endpoints:

- `GET /languages` — locale metadata
- `GET /languages/<locale>.json` — validated locale payload

Missing or invalid locale files fail closed; the UI remains English.

## Build a portable release

After both locale files have been human-reviewed and validated:

```bash
set CAD_LANGUAGE_SOURCE=C:\path\to\reviewed-locales
node build-portable.mjs 0.98 --keep
```

The builder copies both approved files into the single portable ZIP under
`languages/`. It refuses to package drafts or files marked `humanReviewed:false`.
