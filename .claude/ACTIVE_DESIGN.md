# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`.
> (移行期の実行ログは git 履歴・`docs/plans/`・`docs/decisions.md` ADR-028 にある —
> このファイルは常に「今」だけ。)

## Current focus

**Tauri 移行は完遂（ADR-028）・Deno ツリー退役済み（2026-07-05）。** 全体コードレビュー
（5領域並列敵対的 + 検証）→ 検出は low 2件+dead 3件のみで全て解消、docs 大改訂
（architecture/README/roadmap/known-issues 棚卸し/ADR-028+supersede）、コメントの
Deno/phase 参照一掃、`spec/compositz.schema.json` を schemars 生成
（`cargo test -p compositz-core export_schema`）に移行、クリーンビルド済み。

**NEXT（ユーザー指示）: デザイン調整（UI 見た目）+ 残りの総仕上げ。** その後は
[roadmap](../docs/roadmap.md) Phase 3（★in-place update アーク / provenance 表示 /
volumes GC / manifest 表現力）。**wslc は microsoft/WSL#40976 が動くまで保留**
（プロジェクトの根幹の賭け — memory [[wsl-containers-recon]]）。

- 体制: routed top tier = **Fable**（narrow-deep/structured）、broad fan-out = Opus、
  mechanical = Sonnet/Haiku。**★opus には schema を付けない**（[[workflow-structuredoutput-fragility]]）。
- ★user 優先: runnable 優先・フロントエンドのテスト/CI 整備は後回し（`passWithNoTests`）。
- 生成物 2 点はコミット運用: `frontend/src/ipc/bindings.ts`（export_bindings）と
  `spec/compositz.schema.json`（export_schema）。CI 鮮度ゲートは未設置（保留中）。

## Pitfalls index（生きているものだけ）

- **素の TCP 接続は readiness probe として無意味** — docker-proxy が container 側不在でも accept
  する（実測）。readiness = 実 HTTP 交換 + warming poll（ADR-026）。
- **破壊的パスは自分で入力検証** — instance id は削除関数自身が pattern 強制（ADR-025）。
  boundary（CLI/desktop の全 id コマンド）でも検証。load_instance も dir 名由来 id を検証（fail loud）。
- **`HostConfig.Mounts` の bind は host 側 source を自動作成しない** — `BindOptions.CreateMountpoint`
  を daemon に作らせる。
- **cache 共有は create 時 env 注入で強制**（ADR-024、image ENV に勝つ — 実測）。venv preset は
  `UV_PROJECT_ENVIRONMENT` + `UV_PYTHON_INSTALL_DIR`（uv sync は VIRTUAL_ENV を無視）。
- **codeload tarball**: token/API 不要（public）、`HEAD`=default branch、wrapper dir は構造で
  unwrap（ADR-021）。HTTP client は ureq/ring（ADR-027 — reqwest 0.13 は aws-lc-rs を引く）。
- **tauri.conf の hook は object 形式 + 明示 cwd 必須**（文字列形式は cwd が crates/ に落ちて
  Windows CI が死ぬ。実装挙動依存につき CLI 更新時に再確認）。
- **`stream::unfold` は `!Unpin`** — core の stream API は `Box::pin` + `+ Unpin` 境界で返す
  （コンパイル証明テストあり）。
- **vp/rolldown に esbuild は無い**（minify は "oxc"）。vite-plus は 0.1.24 系 catalog pin
  （0.2.x は test に bin 無し）。
- **desktop のローカル検証は flake 経由** — `nix develop -c cargo <fmt|clippy|test>`（devbox は
  pkg-config 非配線で不可）。配布ビルドは CI windows-latest。tauri-specta は
  =rc.21 / specta =rc.22 / specta-typescript =0.0.9 の三つ組 pin（rc.23+ は feature 激変）。
- **Docker は TCP で到達**: `COMPOSITZ_DOCKER_HOST=tcp://host.docker.internal:2375`（実 engine —
  統合テストは compositz-test-* 命名 + 正確な id で後始末、prune/一括系 絶対禁止、共有 cache
  volume に触れない）。
- **Tauri は HTML drag-drop を横取り**（`dragDropEnabled` 既定 true）→ 実ドロップは
  `getCurrentWebview().onDragDropEvent` で PATH を受ける。ブラウザ dev は HTML drag + 合成パス。
  `@tauri-apps/api/webview` は静的 bundle 済み → 動的 import 無効、静的 import + guard。
- **Base UI `Tabs.Panel` は inactive を unmount** — RuntimeLog/SettingsPanel は「タブ有効時のみ
  購読/取得」をこれで実現。build done→settings 自動切替で build ログ本文は DOM から消える
  （テストの落とし穴）。
- **shadcn `TableCell` は `whitespace-nowrap` 既定** — 長文セルは `table-fixed` + カラム幅 +
  `whitespace-normal` で折返す（`break-words` 単独では覆せない）。
- **楽観的更新はしない**（[[feedback-avoid-optimistic-ui]]）— 構造変化(import/duplicate/delete)は
  `reloadRows`(=list_instance_rows 再取得)でのみ baseRows 更新。server-confirmed のみ。
- **dev mock はページ寿命 singleton**（install 冪等・disposer no-op）— StrictMode の遅延 cleanup が
  live 購読を消すレースの構造的封じ。vitest/happy-dom はこのレースを再現しない。
- **headless UI 検証 = システム chromium + CDP 直叩き**（[[compositz-headless-browser-cdp]]）。
  fontconfig 未設定だと `→`/`✓` glyph で renderer FATAL → 最小 fonts.conf + `--disable-remote-fonts`。
  `innerText` は空（`textContent` を使う）。

## Resume point

レビュー + docs + Deno 退役 + クリーンビルドまで完了（このセッション、コミット済み）。
次セッションは **UI デザイン調整**から: 対象は frontend/src/components（現状 shadcn 既定の
素朴な見た目）。仕様の親は docs/（roadmap Phase 3 が次の実装アーク）。
