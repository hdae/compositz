# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`.
> (移行期の実行ログは git 履歴・`docs/plans/`・`docs/decisions.md` ADR-028 にある —
> このファイルは常に「今」だけ。)

## Current focus

**Phase 3 update アーク実装済み（2026-07-05, ADR-029）— Windows 実機確認待ち。**
Slice A = provenance 表示（source/createdAt/updatedAt を view/row/ls へ）+ Rename UI
（`set_instance_name`、空欄/brand 同名は override 解除=manifest 追従）。Slice B =
in-place update（prepare→再trust→commit の2段 staging、GitHub 由来のみ、appId 不変
MUST、id/volumes/config.yaml 維持、旧 image 回収は旧 manifest 基準）。敵対的レビュー
3視点 → high 0・med 4 全修正（load_instance の .old-app 自己修復 / commit 前 ping /
fetching 中 Cancel+identity ガード / staged version 照合）。

**NEXT: Windows 実機確認（update フロー★主眼）→ Slice C（user-facing build args +
--no-cache）or roadmap Phase 3 の他項目（volumes GC / manifest 表現力）。**
**wslc は microsoft/WSL#40976 が動くまで保留**（プロジェクトの根幹の賭け —
memory [[wsl-containers-recon]]）。

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
- **ScrollArea の高さ上限は Root でなく viewport 側へ** — viewport の %高さは auto 親で解決
  しないため、Root に max-h を置くと溢れるだけでスクロールしない。shadcn wrapper は viewport
  class を露出しないので `[&_[data-slot=scroll-area-viewport]]:max-h-64` の arbitrary variant
  で当てる。auto-scroll も同じ data-slot を querySelector して viewport を直接操作（LogView）。
- **stopPropagation は発生源に置く** — カードのヘッダー全体クリック開閉に対し、メタ行の span
  全体で止めると余白クリックまで死ぬ（実際にバグった: 66de739）。止めるのはコピー等の
  操作ボタン自身のハンドラ内で。
- **number input は使わない** — port 等は `type="text"` + `inputMode="numeric"` + 自前検証
  （スピナー除去 CSS はブラウザ依存ハック、number はホイールで値が変わる事故もある）。
- **shadcn の CLI 出力に未使用 import が混ざることがある**（select 系 → scroll-area の
  `import * as React`）— tsconfig の unused エラーになるため import 行のみ調整可
  （[[shadcn-vendor-from-upstream]] の運用どおり中身は不改変）。
- **楽観的更新はしない**（[[feedback-avoid-optimistic-ui]]）— 構造変化(import/duplicate/delete)は
  `reloadRows`(=list_instance_rows 再取得)でのみ baseRows 更新。server-confirmed のみ。
- **dev mock はページ寿命 singleton**（install 冪等・disposer no-op）— StrictMode の遅延 cleanup が
  live 購読を消すレースの構造的封じ。vitest/happy-dom はこのレースを再現しない。
- **headless UI 検証 = システム chromium + CDP 直叩き**（[[compositz-headless-browser-cdp]]）。
  fontconfig 未設定だと `→`/`✓` glyph で renderer FATAL → 最小 fonts.conf + `--disable-remote-fonts`。
  `innerText` は空（`textContent` を使う）。

## Resume point

**update アーク（Slice A+B）完了**: 5fbd973〜671d7ba の 11 コミット（core/cli/desktop/ui/
docs + レビュー修正 4）。全ゲート緑（core+cli 15 suites / desktop clippy+bindings /
frontend tsc+check+build）。**未了 = Windows 実機確認**（update フロー・rename・ls 列・
engine 停止時の commit 拒否）。既知の残余: superseded image 回収漏れは GC 対象
（known-issues 記録済み）/ commit 成功後 reloadRows 失敗の stale 表示は banner 通知で
自己回復。バンドル 521kB 警告は容認中。**Slice C（build args / --no-cache）は未計画 —
着手前に要計画承認。**
