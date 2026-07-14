# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`.
> (移行期の実行ログは git 履歴・`docs/plans/`・`docs/decisions.md` ADR-028 にある —
> このファイルは常に「今」だけ。)

## Current focus

**wslc アーク着手（2026-07-14, ADR-030）— dial-stdio transport 実装済み・Windows
実機確認待ち。** wslc は pipe/TCP を公開せず、唯一の入口は
`wslc system session run docker system dial-stdio`（stdio ブリッジ、fabric8io/
docker-maven-plugin#1928 の実装報告 — 仕様保証なし）。bollard
`connect_with_custom_transport` に接続毎サブプロセスの hyper コネクタを注入
（fork 不要、`crates/core/src/dial_stdio.rs` + `Endpoint::Wslc` =
`COMPOSITZ_DOCKER_HOST=wslc://`）。socat 同形ブリッジで実 engine 検証済み
（ping/version/list/event-stream 維持、CI にも socat 導入で常時カバー）。
敵対的レビュー（ライブラリ実ソース照合 + 実験 E1-E7）→ blocker 0、med 1 修正
（hyper-util pool_timer 配線、下記 pitfall）。前回からの HOLD（microsoft/WSL#40976
待ち）は user 指示で解除 — REST endpoint を待たず dial-stdio 経由で進む。

**port 不達の解明 ✅（2026-07-14, 実機実験 + microsoft/WSL ソース精読 + 3系統調査）**:
バッジ「wslc · online」で接続確証済み。wslc は relay を**自身の create/start 経路で
のみ**登録（label 駆動✗・イベント駆動✗・公式代替 endpoint 無し・隠し knob 無し —
issue/コミュニティ/ソース全数の3系統で一致）。CLI と dial-stdio doorway は同一
default セッション（同一 dockerd）を実機実証。`wslc run -p H:C` は moby へ
**VmPort（内部採番）**で publish し H↔VmPort を label
`com.microsoft.wsl.container.metadata` に記帳（**二重番号空間**）。外部 stop/rm への
帳簿/relay 追随（OnEvent→UnmapPorts）はソース確認済み。
**対応 = D-cli（`wslc create`+`wslc start` 委譲）をユーザー承認済み — 計画書
`docs/plans/wslc-cli-lifecycle.md`（APPROVED）。** 棄却: SDK C DLL（named settings+
Consomme ハードコードで孤立セッション不可避 = #40966 の罠）/ label 偽装（復元専用）/
自前 nc relay（fallback 以下）。COM Compat null-Settings attach は fallback として温存。

**NEXT: 計画書の実機事前チェック①②③（named volume 構文 / ローカル画像 no-pull /
create+start relay + 外部 rm 追随）の結果待ち → 通過後に実装（コミット4分割）。**
他の承認待ち: `docs/plans/slice-c-build-args.md` / `docs/plans/gc-disk-usage.md`
（PROPOSAL・open decisions 要回答）。

- 体制: routed top tier = **Fable**（narrow-deep/structured）、broad fan-out = Opus、
  mechanical = Sonnet/Haiku。**★opus には schema を付けない**（[[workflow-structuredoutput-fragility]]）。
- ★user 優先: runnable 優先・フロントエンドのテスト/CI 整備は後回し（`passWithNoTests`）。
- 生成物 2 点はコミット運用: `frontend/src/ipc/bindings.ts`（export_bindings）と
  `spec/compositz.schema.json`（export_schema）。**CI 鮮度ゲート設置済み（30a8d14）**:
  schema は ubuntu rust job、bindings は windows desktop-artifact job で diff 検査。

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
- **hyper-util legacy Client は pool_timer 既定 None** — idle 回収（90s 既定）は timer を
  配線しない限り一切走らない。接続=プロセスの dial-stdio では滞留が実害（dial_stdio.rs は
  TokioTimer 配線済み）。自前 hyper client を作る時は必ず確認。
- **Windows の tauri テスト exe は app manifest が無いと起動不能**（STATUS_ENTRYPOINT_NOT_FOUND
  = comctl32 v5 が解決され v6 専用 import が欠落）。tauri-build の manifest は
  `rustc-link-arg-bins`(bin 限定)。対処 = desktop/build.rs が **test ターゲットにのみ**
  /MANIFEST:EMBED（`rustc-link-arg-tests` は integration test でのみ確実 → export_bindings は
  tests/ に置く。bin と重複させると RT_MANIFEST 二重でリンカエラー）。
- **dial-stdio のローカル検証は socat 同形ブリッジ**（`socat STDIO TCP:…`/`UNIX-CONNECT:…`）。
  wslc.exe はこの環境（WSL2 上のコンテナ、interop 無し）から触れない — wslc 固有部の検証は
  Windows 実機のみ。
- **wslc の port は二重番号空間** — `wslc run/create -p H:C` の moby 実バインドは VmPort
  （内部採番、例 20002）で、Windows 側 H は wslc の relay 帳簿+label
  `com.microsoft.wsl.container.metadata` にのみ存在。docker API の PublicPort を
  そのまま表示/衝突検査/probe に使うと wslc では全部ズレる（→ list 層で label 翻訳）。
  relay 登録は wslc の create/start 経路のみ（後付け API 無し）。
- **wslc SDK の C DLL（wslcsdk）は default セッションに入れない**（named settings+
  Consomme ハードコード）— 使うと孤立セッション行き（microsoft/WSL#40966 の罠）。
  default セッション attach は COM Compat の null-Settings か wslc.exe CLI のみ。
- **PowerShell 5.1 → 子プロセスの引数で埋め込み `"` が剥がれる**（CRT 再パースで消える）。
  実機実験でリテラル JSON を運ぶときは base64 経由（`… | base64 -d | sh`）で輸送。

## Resume point

**2026-07-14 セッション**: CI 鮮度ゲート（30a8d14）→ wslc dial-stdio transport
（6d0c980 / 81d5084 socat / dd43594 pool_timer / a3c55d3 ADR-030）→ CI windows
修正（ae82961 = テスト exe に app manifest、integration test 化、CI green 確認済）
→ **エンジンバッジにバックエンド種別表示（731a38b、`wslc · online` + hover で
完全 endpoint）**→ docs（8a226ac）。全ゲート緑。

**2026-07-14 続き（wslc port 調査セッション）**: バッジ確証✅ / portprobe 実験→
同一 dockerd 判明 / label 偽装実験（PS 5.1 の引用符剥がれ→base64 で再実験）→
list は Windows 側私有帳簿と確定 / microsoft/WSL ソース精読（scratchpad/wsl-src に
shallow clone）で relay 機構・Compat COM・SDK DLL の全経路を確定 / 3 subagent 調査
（issue・コミュニティ・ソース knob 全数）→ 抜け道なし一致 / **D-cli 承認**・計画書
`docs/plans/wslc-cli-lifecycle.md` 作成。

**★次の入力待ち = 実機事前チェック①②③の結果**（計画書に PowerShell 手順あり:
① `wslc create -v named:/path` 受理 ② ローカル限定イメージの create が pull を
試みない ③ `wslc create -p`+start→relay 到達 → 外部 docker stop/rm → list から消え
port 不達）。全通過→実装開始（コミット1: wslc_cli.rs argv 射影から）。
崩れたら設計へ戻る（③崩れ = down も wslc CLI 委譲へ変更）。

計画承認待ち: `docs/plans/slice-c-build-args.md` / `docs/plans/gc-disk-usage.md`
（各 open decisions 要回答）。既知の残余: superseded image 回収漏れは GC 対象 /
バンドル 521kB 警告は容認中 / dial-stdio の stderr は破棄（ADR-030 記載）。
