# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`. (旧
> Fresh/Deno 期の詳細は git 履歴と `docs/decisions.md` にある — このファイルは常に「今」だけ。)

## Current focus

**Tauri 全面移行 — Phase 1〜4 完了。Phase 4（React UI）= 4a（flake+bindings）/ 4b（縦切り）/ 4c
（dialogs）/ 4d（detail タブ）/ 4e（drag-drop+export）/ 4f（parity 監査+scaffold 掃除）すべて ✅。
parity は Deno 仕様を5領域で並列敵対的監査 → connecting フリッカ bug 1件修正(d098520)、restart の
タブ挙動1件は意図的逸脱として記録、他は全 parity。次は Phase 5（parity 総仕上げ + docs + Deno 退役 +
Windows 実機確認 #3）。** 計画:
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
- **Tauri は HTML drag-drop を横取りする**（tauri.conf `dragDropEnabled` 既定 true）→ ブラウザの
  `ondrop` は発火しない。実 Tauri のファイルドロップは `getCurrentWebview().onDragDropEvent`(payload=
  enter/over/drop/leave、drop に `paths`)で PATH を受ける。ブラウザ dev は HTML drag + 合成パスで代替(4e)。
  NOTE: `@tauri-apps/api/webview` は webviewWindow 経由で既に静的 bundle 済み → 動的 import は無効
  (INEFFECTIVE_DYNAMIC_IMPORT 警告)、静的 import + guard 呼び出しにする。
- **Base UI `Tabs.Panel` は inactive パネルを unmount する**（`keepMounted={false}` 既定/明示）— これを
  利用して RuntimeLog(stream_logs 購読)と SettingsPanel(get_config) は「タブ有効時のみ mount＝購読/取得、
  離脱で unmount＝解除」を実現(4d)。RuntimeLog の async 購読は cancelled フラグで StrictMode 遅延 resolve を
  自己解除。**build done→settings 自動切替で build パネルが unmount → build ログ本文は DOM から消える**
  (テスト時の落とし穴、タブラベルは残る)。
- **shadcn の `TableCell` は `whitespace-nowrap` 既定** — table 内の長文(description 等)は折返さず
  テーブルを max-content 幅に広げ横スクロールを出す。対策=`Table` を **`table-fixed`** + カラム幅指定に
  し、折返させたいセルは **`whitespace-normal`** で上書き（`break-words` だけでは nowrap を覆せない）。4c 後の
  fix で対応。
- **frontend CI の `vp test` は `passWithNoTests: true`**（vite.config）— 4b で skeleton 削除後テスト0で
  "No test files found" exit 1 になり CI が赤だった。テスト方針は「後回し」のまま緑に。テストが入れば通常実行。
- **複製の表示名は core の per-instance override**（`InstanceMeta.name`、`to_instance_view` が
  `meta.name ▷ manifest.name`）。duplicate が `"<名> (copy)"` を記録し同名 recipe の複製を区別可能に。
- **楽観的更新はしない**（ユーザー明示 — memory [[feedback-avoid-optimistic-ui]]）。
  server-confirmed state か明確な rollback のみ。**4c で構造変化(import/duplicate/delete)は
  `reloadRows`(=list_instance_rows 再取得)でのみ baseRows を更新する方式に確定** — 手管理の行
  insert/remove を排し baseRows を server 真実の純関数に。Deno の残楽観2箇所は移植時に解消済み。
- **dev mock はページ寿命のグローバル singleton**（install 冪等・disposer は no-op）。以前は
  disposer が `snapshotPushers.clear()` でグローバル全消しし、StrictMode の捨てマウントの遅延
  cleanup が live 購読を巻き込んで消す**フラキーなレース**を生んだ（4b, fix 361e380）。per-subscription
  破棄は store の `unsubscribe` が担う。**vitest/happy-dom はこの import 解決順レースを再現しない**。
- **headless で UI 実挙動を観察する手段**: システム chromium（devbox）を `--headless=new
  --remote-debugging-port` で起動し、Node 組み込み `WebSocket` で CDP を直叩き（`scratchpad/cdp*.mjs`）。
  page target の ws に直結して `Page.navigate` + `Runtime.evaluate`。注意=**headless の `innerText` は空**
  を返す（`textContent` を使う）／`console.log` はタイミングを変えてレースを隠す（Heisenbug）ので
  観測は window 露出 probe を CDP から on-demand 照会する。
- **この環境の chromium は fontconfig 未設定 → `→`/`✓` 等のグリフ paint で renderer が FATAL
  (`SkFontMgr_FontConfigInterface Not implemented`)、以降 eval がサイレントにハングする**（4c で遭遇）。
  対策=nix store の `DejaVuSans.ttf` を指す最小 `fonts.conf`（monospace/sans を DejaVu へ map）を
  `FONTCONFIG_FILE` で渡し、`--disable-remote-fonts` を付けて起動（`scratchpad/fonts.conf`）。バグは
  アプリ側でなく検証環境側。テスト側のボタン照合は substring だと `Import` が `Import recipe` に誤爆する
  → 一意化（`button[type=submit]` / aria-label）。

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

**4b ✅（2f9adf1 + fix 361e380）: runnable 縦切りを実装・実ブラウザ検証済み。** Phase 0 skeleton 破棄 → bindings.ts を型付き IPC 層
`ipc/client.ts` に → `lib/rows.ts`(snapshot マージ=core view.rs 移植) / `store/instances.ts`(zustand・
**楽観更新なし**・StrictMode 二重購読を sessionToken で無効化) / theme(ADR-019) / components
(InstanceTable/Row/StatusPill/ActionButton/BuildLogPanel)。mock は新コマンド準拠のステートフル fake。
縦切り範囲 = **list + subscribe(snapshot) + install(log) + up + down + open**。**楽観更新は排除済み**
(up/down/install は busy スピナー + snapshot 駆動で server-confirmed)。**新規 shadcn 追加なし**
(table/badge/button/scroll-area 既存で充足)。**検証: vp check 緑(既知 warning 2)/ tsc-b+vp build 緑 /
dev 新規13モジュール transform 200。**★実ブラウザ検証済み（headless chromium + CDP、list/install/up/down/
open/theme を実クリックで確認、5/5 安定）。ユーザー報告の Start/Stop 無反応 = dev mock の StrictMode
レース（fix 361e380）を実 chromium で再現・特定・修正。** Windows 実 backend 確認は Phase 4/5 の節目。

**4c ✅（0abc2ff store/IPC/mock + abc7bbc dialog UI）: import/trust/delete/duplicate を実装・実ブラウザ
検証済み。** ImportBar(File/GitHub)・非 dismiss TrustDialog・DeleteDialog(volumes 既定ON/bind 既定OFF)・
GithubImportDialog・行の duplicate/delete(tooltip)・notice バナー。★楽観排除は `reloadRows` 再取得方式で
構造的に確定(上記 Pitfalls 参照)。shadcn は CLI 生成のみ(base-nova style=Base UI、**`--base` フラグ不要**・
手書きなし): alert-dialog/dialog/input/checkbox/label/tooltip。dep 追加=@tauri-apps/plugin-dialog 2.7.1。
検証=tsc-b+vp check(既知warning2)+vp build 緑 / 実ブラウザ CDP 28/28 ×4 安定(font crash は fontconfig で
回避、Pitfalls 参照)。**File import の native picker は実 Tauri のみ実挙動未確認**(mock は合成パス)→ Windows 実機で。

**4d ✅（61941f7 infra + 56ee654 UI）: 展開行を Base UI Tabs 化。** build log / runtime log(streamLogs・
running 時のみ購読) / services(定義ベース列挙・ready で Open) / settings(get/set_config・定義ベース衝突検出・
差分のみ保存・running なら Restart)。action駆動タブ遷移(install→build→settings / start→logs / ready→
services)。LogView に build/runtime 共通化。敵対的レビュー(並行性7観点)全 holds・実バグ無し、mock の
dead-disposer nit のみ修正。実ブラウザ CDP 20/20 + 4c/UI-fix 回帰緑。**Settings の実 backend 実挙動
(get/set_config・restart)は Windows 実機確認送り**(mock は合成 settings)。

**4e ✅（0251b57 export + a15ec3a drag-drop）**: Settings の Storage に Export(mount→save picker→
exportMount)、ウィンドウ全体 drag-drop 取込(実 Tauri=onDragDropEvent の PATH / ブラウザ=HTML drag+合成)。
banners(offline/notice/error)は 4c で実装済み。実ブラウザ CDP 13/13 + 全回帰緑。**Tauri の onDragDropEvent
と実 save ダイアログ・実 export は Windows 送り**(ブラウザは合成パス/no-op)。

**4f ✅（d098520 fix + 1201ce7 chore）: parity 監査 + scaffold 掃除。** Deno `InstanceList.tsx` を5領域
(import/trust・delete/duplicate・actions/status/tabs・detail(log/services/settings)・rows/snapshot/theme)
で並列敵対的監査 → **connecting フリッカ bug 1件修正**(mergeRow が最初の snapshot 前に base の running/
services をゼロ化＝毎起動で実行中→未実行表示、d098520)。他4領域は全 parity。掃除=README を実プロジェクト化・
shadcn を devDeps へ(AGENTS.md は Vite+ 自動生成のため保持)。**DECIDED: restart は Deno と違い detail タブを
動かさない**(Deno は logs へ切替 / React は Settings 維持＝不意なタブ移動を避ける方が良い、[[feedback-avoid-optimistic-ui]]
と同系の anti-surprise 方針。参照: 監査 07-05)。

**NEXT: Phase 5 — parity 総仕上げ + docs 整備 + Deno 退役 + Windows 実機確認 #3。** Deno `deno task test`
(160本)を退役まで無傷維持。実 backend 依存の未検証(Settings の get/set_config・restart・drag-drop の
onDragDropEvent・save/export・native picker)を Windows 実機で確認。**★user 優先(07-04): runnable 優先・
テスト/CI 後回し・ローカルは vp dev + browser + mockIPC、実 backend は Windows。**
