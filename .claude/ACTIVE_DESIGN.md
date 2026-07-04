# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`. (旧
> Fresh/Deno 期の詳細は git 履歴と `docs/decisions.md` にある — このファイルは常に「今」だけ。)

## Current focus

**Tauri 全面移行 — Phase 1〜3 完了。Phase 4（React UI）着手中: 4a（flake ビルド環境 +
bindings 生成）✅ / 4b（runnable 縦切り実装）✅（2f9adf1・静的緑・ブラウザ実機確認待ち）。次は
4c（dialogs）。** 計画:
[docs/plans/tauri-migration.md](../docs/plans/tauri-migration.md)（承認済み親計画）+
[docs/plans/tauri-migration-execution.md](../docs/plans/tauri-migration-execution.md)
（**実行詳細・例外時対応 — 実装セッションはこちらに従う**）。

- Phase 0 ✅ 完了・Windows 実機検証済み（npipe 長時間 logs/events ストリーミング OK — 移行最後の
  技術リスクは消滅）。スタック: bollard 0.21 / tauri 2.11.5 / vite-plus 0.1.24 系 / React 19 /
  shadcn Base UI。
- **既存 `packages/`（Deno ツリー）は凍結** — 移植の仕様書として読むだけ。Phase 5 で退役。
  `deno task test`（160 本）は退役まで無傷を維持すること。
- **update アークは凍結**（移行後に新スタックで実装）。**wslc は microsoft/WSL#40976 が動くまで
  保留**（プロジェクトの根幹の賭け — memory [[wsl-containers-recon]]）。
- 体制: **Opus 単独遂行**（Fable 不在）。サブエージェントに schema を付けない・検証は実測ゲート 優先
  — 詳細は execution 計画の「体制」節。

## Pitfalls index（新スタックでも生きるものだけ）

- **素の TCP 接続は readiness probe として無意味** — docker-proxy が container 側不在でも accept
  する（実測）。readiness = 実 HTTP 交換 + warming poll（ADR-026）。listen 開始の Docker event は
  存在しない。
- **破壊的パスは自分で入力検証** — `rm .` が store 全消しになった事故（ADR-025）。instance id は
  削除関数自身が pattern 強制。Rust 移植でも同じ構造にする（1c）。
- **`HostConfig.Mounts` の bind は host 側 source を自動作成しない** —
  `BindOptions.
  CreateMountpoint: true` を daemon に作らせる（remote DOCKER_HOST から core は host
  FS に触れない）。
- **cache 共有は create 時 env 注入で強制**（ADR-024、image ENV に勝つ — 実測）。venv preset は
  `UV_PROJECT_ENVIRONMENT` + `UV_PYTHON_INSTALL_DIR`（uv sync は VIRTUAL_ENV を無視）。
- **codeload tarball**: token/API 不要（public）、`HEAD`=default branch、slashed ref は literal
  path、wrapper dir は名前でなく構造で unwrap（ADR-021）。
- **tauri.conf の hook は object 形式 + 明示 cwd 必須**（親計画 must-fix #8 — 文字列形式は cwd が
  crates/ に落ちて Windows CI が死ぬ。実装挙動依存につき CLI 更新時に再確認）。
- **`stream::unfold` は `!Unpin`** — core の stream API は `Box::pin` + `+ Unpin` 境界で返し、
  desktop pump と同型の `.next().await` テストをコンパイル証明として維持する。
- **vp/rolldown toolchain に esbuild は無い** — esbuild 系オプション禁止（minify は "oxc"）。
  vite-plus は 0.1.24 系 catalog pin（0.2.x は test に bin 無し）。
- **desktop はローカル compile 可能（`flake.nix` 経由）** — `nix develop -c cargo <fmt|clippy|test>`。
  webkit2gtk-4.1/gtk3/dbus/libsoup の pkg-config `.dev` を stdenv setup hook が配線する。
  **devbox（global も project も）は配線せず不可**（かつ per-package 独立 pin で GUI 版ズレ）。
  bindings は `cargo test -p compositz-desktop export_bindings` で生成（決定的・tauri-specta rc.21
  は Cargo.lock 固定）。flakes は `~/.config/nix/nix.conf` で有効化済み。「desktop は CI 専用」は撤回。
- **Docker は TCP で到達**: `COMPOSITZ_DOCKER_HOST=tcp://host.docker.internal:2375`（この dev 環境
  自体が同じ engine 上の container — 統合テストは compositz-test-* 命名 + 正確な id で後始末、
  prune/一括系 絶対禁止、共有 cache volume に触れない）。
- **楽観的更新はしない**（ユーザー明示 — memory [[feedback-avoid-optimistic-ui]]）。
  server-confirmed state か明確な rollback のみ。

## Resume point

**Phase 1（core）+ Phase 2（CLI）+ Phase 3（desktop backend）完了。** Phase 3 は 3a〜3e:
view-model 導出 + probe/snapshot を core へ移植（ローカル全検証）→ desktop に非 streaming
11 コマンド + push-stream 4 コマンド + AppError(serde tagged) + plugin 群を配線（CI 専用）。
tauri-specta は **=2.0.0-rc.21 / specta =2.0.0-rc.22 / specta-typescript =0.0.9** の三つ組
（plan の rc.25 は feature 激変で不採用）。★F5 境界検証を全 id コマンドに適用。desktop の
コンパイル検証は CI(Desktop artifact/windows) + 敵対的レビュー（3c/3d/3e で計 3 回、実ソース
照合、検出ブロッカーは修正 or feature-unification による false alarm と実証）。詳細は execution
計画の進捗欄。

**Windows 実機確認 #2 ✅ 実施済み**（ユーザー確認）: Desktop artifact(windows) 緑・app 起動OK・
二重起動で既存ウィンドウ focus（single-instance 動作）。**ただし起動時に
`Command stream_events not found` エラー** — これは **旧 Phase 0 skeleton frontend
(`frontend/src/`)** が 3c で削除した Phase 0 コマンド（`list_containers`/`stream_logs`/
`stream_events`、`frontend/src/ipc/index.ts`）を叩くため=**想定内・backend バグではない**。
DevTools 不可のため新コマンドの直接検証は未。**このエラーの修正 = Phase 4 の frontend 再構築
（★Phase 4 の最初のタスク）。**

**4a ✅（c9ae23f / 0c6a3de / 624c055）**: flake.nix でローカルビルド環境確立 +
`frontend/src/ipc/bindings.ts` 生成・格納（15 コマンド + 23 型）。生成は export_bindings テスト
（`nix develop -c cargo test -p compositz-desktop export_bindings`、run() の dev-run export は撤去）。
**bindings.ts は有効 TS 化済み（624c055: 衝突する `TAURI_CHANNEL` placeholder を除去 + 生成物として
`// @ts-nocheck` 前置 / vite.config の fmt・lint `ignorePatterns` で除外）→ 4b でそのまま消費可。追加
作業なし。** desktop の CI ゲート（clippy/test/bindings 鮮度）追加は後回し（user 合意・4b 後 or Phase 5）。

**4b ✅（2f9adf1）: runnable 縦切りを実装。** Phase 0 skeleton 破棄 → bindings.ts を型付き IPC 層
`ipc/client.ts` に → `lib/rows.ts`(snapshot マージ=core view.rs 移植) / `store/instances.ts`(zustand・
**楽観更新なし**・StrictMode 二重購読を sessionToken で無効化) / theme(ADR-019) / components
(InstanceTable/Row/StatusPill/ActionButton/BuildLogPanel)。mock は新コマンド準拠のステートフル fake。
縦切り範囲 = **list + subscribe(snapshot) + install(log) + up + down + open**。**楽観更新は排除済み**
(up/down/install は busy スピナー + snapshot 駆動で server-confirmed)。**新規 shadcn 追加なし**
(table/badge/button/scroll-area 既存で充足)。**検証: vp check 緑(既知 warning 2)/ tsc-b+vp build 緑 /
dev 新規13モジュール transform 200。★ブラウザ実機(vp dev+mockIPC)と Windows 実 backend の UI 挙動確認は
未 — headless で JS 実行検証不可**。

**NEXT: 4c〜4f — React UI 残り。** 4c dialogs(trust 非 dismiss / delete(volumes+export 安全弁) /
duplicate / import(File+GitHub))、4d detail タブ(build/runtime log=stream_logs・services・settings=
get_config/set_config・restartNeeded)、4e banners/drag-drop/open/export、4f parity 総点検 + scaffold
残骸掃除(frontend/README.md・AGENTS.md・`dependencies` の `shadcn`)。**残る楽観更新2箇所を snapshot/応答
駆動へ**: removeInstance(delete の行削除→server-confirmed) / trustInstall(trust 後の行挿入→応答駆動)。
shadcn は CLI 追加のみ(`--base base`)。挙動 parity は各 ADR（execution 計画 Phase 4 節・
InstanceList.tsx が仕様）。**★user 優先(07-04): runnable 優先・テスト/CI 後回し・ローカルは vp dev +
browser + mockIPC、実 backend は Windows。**
