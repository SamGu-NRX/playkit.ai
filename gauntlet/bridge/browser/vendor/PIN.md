# Vendored game: gabrielecirulli/2048

- Repository: https://github.com/gabrielecirulli/2048
- License: MIT (see `2048/LICENSE.txt`, vendored unmodified)
- Pinned commit SHA: `478b6ec346e3787f589e4af751378d06ded4cbbc` (upstream `main` at vendoring time; the game has been stable there for years)
- Vendored tree: everything in the pin except `.git` — `index.html`, `js/`, `style/`, `meta/`, `favicon.ico`, `LICENSE.txt`, `README.md`, `CONTRIBUTING.md`, `Rakefile`.

Reproduce the pin:

```sh
git clone https://github.com/gabrielecirulli/2048.git
cd 2048 && git checkout 478b6ec346e3787f589e4af751378d06ded4cbbc
# diff against vendor/2048/ (modulo .git) to confirm
```

The fault-check copy at `/2048-faulty/` is served from this same tree with the
single-line patch documented in `../faulty-copy.mjs`.
