# Tauri 移行 実行計画 — Phase 1〜5 詳細（Opus 単独遂行版）

親計画: [tauri-migration.md](tauri-migration.md)（承認済み）。本書はその実行詳細で、 **Fable
不在・Opus が主導する前提**の手順書。実装セッションは冒頭で memory と本書を読むこと。

## 前提（2026-07-03 時点の到達点）

- **Phase 0 完了 + Windows 実機検証済み**（ユーザー確認: NSIS インストール → 一覧 / logs / events
  ストリーミング動作。npipe 長時間ストリーミングという移行最後の技術リスクは消えた）。
- 承認は親計画で済んでいる。**Phase 単位の再承認は不要**（Workflow ルール: 前提が崩れた /
  新要求が出た / 実トレードオフのある判断が出た、の 3 条件でのみ停止して質問）。
- スタック: bollard 0.21 / tauri 2.11.5 / tauri CLI 2.11.4 (CI pin) / vite-plus 0.1.24 系 (catalog
  pin) / React 19 / shadcn Base UI。

## 体制 — Opus 単独遂行の含意

- サブエージェントは Opus（機械的作業のみ Sonnet/Haiku 可）。**Fable 検証は使えない**。
- **サブエージェントに structured-output schema を付けない**（Opus は他フィールドを XML タグ化して
  最初の string に詰める encoding 失敗でループする — Phase 0 で実証）。最終報告は prose。
  構造化が必要なら本文中に JSON を書かせ、orchestrator が parse して不備なら tree を直接検証。
- 検証の軸足を**実測ゲート**に置く: テスト（fault injection 含む）・実エンジン統合・CI・
  ビルド成果物の中身確認。レビュー agent を使う場合は独立 2 視点以上、指摘には file:line と
  再現コマンドを必須にする（prose）。「もっともらしい推論」だけで挙動を確定しない。
- エージェント死亡時: **先に tree を見る**（作業は大抵完了している）。報告は transcript の
  StructuredOutput/tool_use 初回 attempt から回収可能。残作業だけ新 workflow で再開。

## 普遍ルール（全 Phase 共通）

- **Spec = `packages/` の現物コードとテスト + `docs/decisions.md` の ADR。Parity first** —
  移植中に「元の挙動が変」と思っても直さない。known-issues 候補として報告し、修正は別タスク
  （quarantine 原則）。挙動差を入れる場合は必ず報告事項に列挙してユーザー判断。
- **Test-first**: 対象モジュールの Deno テストを仕様として先に Rust へ移植 → 赤 → 実装 → 緑。
  アサーションの弱体化禁止。同期機構の差（FakeTime / SSE vs Channel）はテスト側の flush だけ
  合わせ、その編集をコミット本文で申告。Deno 固有で移植不能なものは省略理由をコミット本文へ。
- **ゲート（毎サブステップ）**: `cargo fmt --all --check` /
  `cargo clippy --all-targets -- -D
  warnings` / `cargo test`（env なし +
  `COMPOSITZ_DOCKER_HOST=tcp://host.docker.internal:2375`）/ frontend を触ったら
  `pnpm -C frontend run check && run test && run build` / 既存 Deno ツリーの無傷確認
  `deno task test`（Phase 5 の退役まで）。
- **コミット**: Conventional Commits・日本語 description・1 論理変更 = 1 コミット・fix には blast
  radius。コミット前に `git diff` 通読（無関係な再整形の混入禁止）。
- **Docker 安全（Phase 1 から書き込みを伴う）**:
  - この環境の engine はユーザーの実 Docker Desktop。統合テストが作る object は名前
    `compositz-test-*` + `io.compositz.instance` ラベル必須。teardown は**保存した正確な id/name
    のみ**。prune 系・一括系 API は絶対禁止。unlabeled への stop/rm 禁止。
  - 共有 cache volume（`compositz_uv` / `compositz_hf` / `compositz_cache_*`）に触れない。
  - 破壊的統合テスト（up/down/rm/install の実行系）は `COMPOSITZ_E2E=1` で別ゲート。 通常の
    `cargo test` では走らせない。CI ubuntu では有効化してよい（使い捨て daemon）。
- **コンテキスト運用**: 各 Phase 完了 = checkpoint（コミット + memory 更新 + 本書の進捗欄更新） →
  compact。再開手順 = memory index → 本書 → 対象 Phase の Deno 現物を再読。

## Phase 1 — core 移植（test-first）

置換されるもの（移植しない）: `http.ts` / `transport.ts` / `engine/client.ts` / `engine/types.ts`
（計 ~1,070 行 — bollard が代替。`http_test` / `logs_test` の意味が残るアサーションだけ拾う）。

| #  | 対象 (packages/core/src/)                                    | 行数(実+test)       | 移植先 / 要点                                                                                                                                                                                                                                                                  |
| -- | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1a | `recipe/manifest.ts`                                         | 236+360             | serde_norway + schemars 1.0。`deny_unknown_fields` で fail-loud。zod の default/refine 相当は明示コード化。`scripts/gen_schema.ts` は schemars 出力で置換                                                                                                                      |
| 1b | `brand.ts`, `storage.ts`                                     | 61+80+64            | brand 定数 + label()。storage は directories crate（per-OS パス）+ dunce。thiserror 階層（Phase 3 の tagged enum に載る形を意識）                                                                                                                                              |
| 1c | `recipe/instance.ts`, `recipe/config.ts`, `recipe/loader.ts` | 167+80+62 (+176+86) | instance store。**atomic write = tempfile `NamedTempFile::new_in`(同一 dir)+`sync_all`+`persist`**（known-issue の構造的解消）。**id 検証を store 関数自身が強制**（`rm .` store 破壊事故の再発防止 — ADR-025）                                                                |
| 1d | `recipe/github.ts`                                           | 154+193             | reqwest 単一 Client + rustls + read_timeout。codeload tar.gz。`owner/repo[/subdir][@ref]` パース（ADR-021）                                                                                                                                                                    |
| 1e | `recipe/ingest.ts` + `github.ts` の `ingestGithub`           | 325+383 / 154の残   | tar-rs + flate2 **MultiGzDecoder** + zip（CVE-2025-29787 修正版）。**zip-slip / path traversal 検査**。`spawn_blocking`。ディスクへストリーミング・サイズ上限なし（ADR-017）。tokio-tar/async-tar 禁止。**★1d申し送り: `safeRelSubdir`（normalize + `\`→`/` + `..`/絶対パス拒否）を必ず移植** — パーサ側の subdir 検証は仕様上わざと緩く（`/`区切りしか見ず `a\..\b`・NUL・`con` を通す）、実防御はここ。抜けると Windows で `owner/repo/a\..\b` が traversal になる。**`ingest_github`＋reqwest 単一Client+rustls+read_timeout はここへ統合**（1d で純粋 spec 層のみ移植済み）                                     |
| 1f | `recipe/run.ts`                                              | 275+314             | container spec 生成: persistedMounts / **cache env 注入は create 時**（ADR-024: `UV_PROJECT_ENVIRONMENT` `UV_PYTHON_INSTALL_DIR` 等）/ ports は **`deconflictHostPorts`**（定義ベース衝突解決 ADR-023）/ labels（instance/recipe）/ `.launched.yaml`（再起動要否判定）         |
| 1g | `recipe/operations.ts`                                       | 420+89              | up/down/install/delete/export/duplicate。**pitfalls チェックリスト**: 削除 = volume デフォルト削除 + export 安全弁（未起動 helper + archive API、teardown 順序厳守）/ duplicate = config 継承 minus hostPorts → deconflict / install = tar context から build + 進捗ストリーム |
| 1h | engine 追補                                                  | —                   | bollard で不足が出た API を core に追加（volume create/rm・archive get/put・build 等は 1:1 確認済みだが実装時に照合）                                                                                                                                                          |

完了条件: 移植テスト全緑（unit + 実エンジン統合）+ `COMPOSITZ_E2E=1` で import→install→up→ down→rm
の round-trip が実エンジンで通る + 既存 Deno テスト 160 本無傷。

## Phase 2 — CLI 移植（11 コマンド）

`doctor / import / ls / duplicate / install / up / down / rm / export / ps / hello`（clap derive）。
`rm` の `--keep-data` / `--purge`、`export` の「mount 省略時は一覧表示」、`hello` は実エンジン
round-trip（parity 維持）。ps は Phase 0 実装を core の新 API に載せ替え。exit code / stderr の
慣例は Phase 0 の cli を踏襲。

## Phase 3 — desktop backend（commands + Channels）

現 API route → IPC の対応（route は `packages/ui/routes/api/` の現物が仕様）:

| 現 route                         | IPC                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `events.ts`（SSE snapshot push） | `subscribe_instances(Channel)` — イベント駆動 + safety refresh。**serialize + coalesce**（ADR-026） |
| `instances/[id]/[action].ts`     | `instance_action(id, action)` 群。install は build ログを Channel で                                |
| `instances/[id]/config.ts`       | `get_config` / `set_config`                                                                         |
| `instances/[id]/logs.ts`         | `stream_logs`（Phase 0 実装を instance 対応に）                                                     |
| `instances/[id]/export.ts`       | `export_mount`（dialog plugin で保存先選択）                                                        |
| `import.ts` / `import-github.ts` | `import_recipe`（dialog / GitHub ref 引数）                                                         |
| `open.ts`                        | opener plugin 呼び出しへ置換                                                                        |

- **readiness は HTTP probe**（素の TCP は docker-proxy が受けるため無意味 — ADR-026）+ warming
  poll。PublicPort は起動即出現する点も踏襲。
- **error enum**: core の thiserror を serde internally-tagged enum で境界化 → TS discriminated
  union。
- **tauri-specta `=2.0.0-rc.25`** をここで導入（Rust 型 → TS 生成）。
- **stream lifecycle を解消**: Phase 0 の fire-and-forget を廃し、AbortHandle registry +
  unsubscribe/unlisten コマンド。ウィンドウ破棄時に全 stream 停止。
- plugins: single-instance（**最初に登録**）/ dialog / log / window-state（opener は導入済み）。
- 完了時 **Windows 実機確認 #2**（artifact 渡し + 番号付き手順）。

## Phase 4 — React UI

`packages/ui/islands/InstanceList.tsx`（1,434 行モノリス）を分解して再構築。分解案: InstanceTable /
InstanceRow / StatusBadge / ActionButtons / TrustDialog / DeleteDialog / DuplicateDialog /
ImportDialog（File・GitHub）/ LogsTab / ServicesTab / SettingsTab / Notifications /
ThemeProvider。zustand store は関心ごとに小さく分割。

挙動 parity チェックリスト（各 ADR が仕様）:

- ADR-020: trust dialog は**非 dismiss**（Yes=build / No=削除+per-instance image 回収）、タブパネル
  （build/runtime log + Services=live PublicPort join）
- ADR-022: Settings タブ（config.yaml override、up 時適用）
- ADR-023: ports 表示 = `live ▷ override ▷ manifest`、停止中もサービス表示、「ブラウザで開く」
- ADR-025/026: 削除 dialog の export 安全弁、GUI duplicate、アクション連動タブ、readiness 表示
- **楽観的更新の禁止（ユーザー明示の好み）** — server-confirmed state か明確な rollback のみ
- dark mode = shadcn Vite ThemeProvider（class + localStorage + system 既定 — ADR-019 同義）
- shadcn は **CLI 追加のみ・手書き禁止**（`--base base`）。vendored 警告 2 件は既知
- scaffold 残骸の掃除: frontend/README.md・AGENTS.md・`dependencies` の `shadcn`（dev 専用 CLI）

## Phase 5 — parity 総点検 + docs 大改訂 + 退役

- 機能 matrix で新旧突き合わせ（CLI 11 / route 7 / UI 挙動チェックリスト）。
- docs: 移行 ADR 新設、ADR-007/008/013/016/018 等に superseded 記録、known-issues 棚卸し
  （config.yaml atomic write は解消済みへ、`.gitignore` の `/desktop/` 死にエントリ整理）、 README /
  roadmap / CLAUDE.md（コマンド・構成・doc index）全面更新。
- 退役: `packages/` `bin/deno` `deno.json` `deno.lock` `scripts/` 削除、`.gitignore` の Deno 項
  整理。CI から deno 依存が消えたことを確認。
- **要判断（ユーザー）**: LICENSE 選定（現在ファイルなし・Cargo.toml から意図的に未設定）。
- 完了時 **Windows 実機確認 #3**（フル機能・リリース前検収に相当）。

## 例外時対応 playbook

| 事象                            | 対応                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop crate の CI 失敗        | ローカルでコンパイル不能なのは仕様。ログ全文読解 → 1 修正 1 push。**2 連続失敗で停止しアプローチ再考**（Phase 0 の教訓: Unpin / API 署名系はローカルの core にコンパイル証明テストを置いて再発防止）             |
| tauri.conf の hook が CI で死ぬ | must-fix #8: hook は object 形式 + 明示 cwd。tauri CLI 更新時は挙動再確認（実装挙動依存）                                                                                                                        |
| サブエージェントの出力事故      | 上記「体制」節。schema 禁止 / tree を先に検証 / transcript 回収 / 残作業のみ再開                                                                                                                                 |
| bollard に API 不足             | docs.rs + source を確認。無ければ raw HTTP で叩く前に**ユーザーへ相談**（hack を黙って入れない）                                                                                                                 |
| テスト移植の齟齬                | 同期機構の差ならテスト側 flush のみ修正 + 申告。仕様が本当に食い違うなら停止して質問                                                                                                                             |
| vp toolchain の破綻             | catalog 整合（0.1.24 系で core/CLI/test 一致）をまず疑う。esbuild 系オプションは禁止（oxc のみ）。解けなければ **plain Vite fallback（承認済み）**。vite-plus-test 0.2.x が出たら別コミットで catalog 更新を検討 |
| tauri-specta rc 不適合          | 手書き TS 型 + 双方向契約テストで代替し、ユーザーへ報告                                                                                                                                                          |
| Windows でしか出ない挙動        | transport 非依存に設計して TCP でテスト。節目（Phase 3/5）の実機確認に番号付き手順を添える。**コードレベル「修正が入っているはず」を実機確認の代わりにしない**                                                   |
| 元コードのバグ発見              | 直さず parity 移植 + known-issues 候補として報告（quarantine）。触るなら独立コミット + 事前承認                                                                                                                  |
| 安全ガードの除去が正しい場合    | 代替ガード + ユーザー通知を設計に含め、構造化選択（許可+通知/撤去/現状維持）で提示                                                                                                                               |
| 判断に迷う                      | 停止して番号付きで質問。推測で進めない                                                                                                                                                                           |

## 進捗（実装セッションが更新すること）

- [x] Phase 0 — 足場 + walking skeleton（2026-07-03、Windows 実機検証済み）
- [x] **Phase 1 — core 移植 完了**（1a〜1h 全済み。175 tests(mode A/B) + E2E round-trip を実エンジンで
      緑(8.13s, teardown リーク0 実機確認) + Deno 160 無傷）。1g/1h: bollard 書込面を async_stream で
      `'static` 化・operations は engine-free deconflict のみ unit test で他は E2E 検証・敵対的3視点
      レビュー(destructive-scope 安全 全4 holds)で4件修正(remove_image を unforced へ安全ガード復元 /
      pull_image tag 既定 latest / remove_volume 404許容 / bind_dir_failed 型)。zip無し。DoS は
      limitations 記録。bollard版注意=MountType/exposed_ports=Vec→object serde。
      **★Phase 2/3 必須(レビュー F5): CLI/desktop は instance_id を境界で検証してから down/up/
      remove_instance_* を呼ぶこと**（core 関数は parity で raw &str を受ける — Deno UI routes 同様に
      呼ぶ側が検証。export_mount の cancel 時 helper leak は sweep が backstop の既知差）。
- [x] **Phase 2 — CLI 移植 完了**（fe4f7f4。11 コマンド clap 化。core 追補: engine
      ping/version/wait_container/create_container_simple + store系 re-export + engine
      list_instances→list_managed_containers 改名。★F5 境界検証を全破壊パスに適用。
      doctor は unix connect の eager 失敗で診断出力を失う不具合を修正(resolved_endpoint_
      description で handle 非依存)。敵対的2視点レビュー(parity+correctness / safety+rename)
      = rename 完全・破壊系は全て compositz-* 命名で安全。doctor/ps/ls/hello/import/duplicate/
      export一覧/rm/★境界拒否を実機検証。全 test 緑 + Deno 160 無傷。
      **F1 ✅解決(e1c8747, ユーザー承認): core `duplicate_instance` に is_valid_instance_id 自己
      検証を追加(remove_instance_dir/ADR-025 と対称化)。fault-injection テスト(store 外 victim を
      `../victim` で複製→拒否+store無変更、ガード撤去で fail を実証)。破壊系 path-touching core sink
      は remove_instance_dir と duplicate_instance の両方が自己防御に。**
      parity 差(受容): ps=Phase 0 table / clap arg エラー=exit 2 / hello の色分け・pull 進捗簡略。
- [x] **Phase 3 — desktop backend 完了**（3a〜3e。**Windows 実機確認 #2 は未実施** —
      要 push + artifact 実行）。
      - 3a(3816790): core `view` モジュール（dashboard.ts/instance-view.ts の純導出を移植、
        Deno 19 相当 + build_settings 2 = 21 テスト緑）。specta optional feature 導入
        （view 型 + Placement に cfg_attr）。config file-IO 再エクスポート。withOptimisticAction
        は不採用（Phase 4 判断）。
      - 3b(fe721b5): core `probe` + `build_snapshot`（probe.ts + events.ts doPush 移植）。
        ureq(spawn_blocking) で HTTP probe（素 TCP は docker-proxy が受けるため実 HTTP のみ）、
        RUNNING×web port だけ probe、warming 判定。engine に list_managed_raw 追加。core に
        tokio(rt) 依存。probe 5 本 + 実エンジン build_snapshot smoke 緑。
      - 3c(d1c6fad): desktop 非 streaming コマンド 11 本 + AppError(serde tagged) +
        tauri-specta 配線。★F5 境界検証を全 id コマンドに（load_by_id / inline）。core 追補=
        PortBump/Override を specta 化 + validate_override 公開。**依存決定: tauri-specta
        =2.0.0-rc.21 / specta =2.0.0-rc.22 / specta-typescript =0.0.9 の三つ組**（plan の
        rc.25 は feature 激変で不採用、playbook「rc 不適合→代替+報告」）。敵対的2視点レビュー
        →ブロッカー1件(From<io::Error> 欠落)修正。**CI(Desktop artifact/windows)でコンパイル
        通過をユーザー確認済み**。
      - 3d(f98a230): push-stream コマンド(subscribe_instances/stream_logs/instance_install/
        unsubscribe) + AbortHandle レジストリ + window teardown。snapshot_pump は単一ループ
        select! 設計で events.ts の serialize+coalesce を構造的に排除。敵対的レビューの2件
        「ブロッカー」は feature-unification による false alarm（tauri specta / tokio time は
        tauri-specta / bollard が graph 全体で有効化済み）と実証、SHOULD 推奨で両 feature を
        明示宣言。
      - 3e(90506d6): plugin 登録(single-instance 最初/dialog/log/window-state) + capabilities。
        review 0 ブロッカー。
- [~] Phase 4 — React UI（**4a ✅ / 4b〜4f 未**）
      - 4a(c9ae23f): **flake.nix でローカルビルド環境確立**（単一 nixpkgs-unstable + rust-overlay
        1.96.1 の devShell。webkit2gtk-4.1/gtk3/dbus/libsoup の pkg-config を stdenv hook で配線）。
        **「desktop はローカル compile 不可・CI 専用」の前提を撤回** — 以後 fmt/clippy/test/bindings
        生成をローカル flake で実検証。**devbox は project shell でも pkg-config を配線せず不可**
        （version も per-package 独立 pin で GUI 版ズレ）→ flake へ。bindings 生成を canonical な
        `#[test] export_bindings` に一本化（run() の debug-only export 撤去）、`frontend/src/ipc/
        bindings.ts`(15 コマンド+23 型) 生成・格納（決定的）。specta-typescript を dev-deps へ。
        clippy(collapsible_if) 2件を let-chains へ collapse（CI は desktop 非対象のため flake で初検出）。
        624c055 で生成 bindings.ts を有効 TS 化（衝突 placeholder 除去 + `// @ts-nocheck` + vite.config
        fmt/lint `ignorePatterns` 除外）= 4b でそのまま consume 可。desktop の CI ゲート追加は後回し（user 合意）。
      - 4b(2f9adf1): **runnable な縦切りを実装**。Phase 0 skeleton(App/ipc/components/store)を破棄し、
        bindings.ts を型付き IPC 層 `ipc/client.ts`(Result→throw + Channel 購読ハンドル)に包む。新規:
        `lib/rows.ts`(snapshot マージ = core view.rs の instance_services/to_instance_rows join を移植)、
        `store/instances.ts`(zustand、**楽観的更新なし** — up/down/install は busy スピナー + snapshot 駆動で
        server-confirmed、StrictMode 二重購読を sessionToken で無効化)、theme(ADR-019 class+localStorage+
        system 既定・CSP 安全な main.tsx early boot に分割)、components(InstanceTable/Row/StatusPill/
        ActionButton/BuildLogPanel)。mock を新コマンド準拠のステートフル fake へ(Channel plumbing は Phase 0
        実証パターンを object payload 対応に一般化)。**縦切り範囲 = list + subscribe(snapshot) + install(log
        stream) + up + down + open**。**未着手(4c〜4f 送り)**: delete/duplicate/import dialog、settings/services
        detail タブ、trust dialog、drag-drop、stream_logs(runtime log)、テスト。**新規 shadcn 追加なし**
        (table/badge/button/scroll-area 既存で充足)。**検証: vp check 緑(既知 warning 2 のみ)/ tsc -b + vp
        build 緑 / dev サーバで新規13モジュール transform 200・エラー0。**★実ブラウザ検証済み（headless
        chromium を CDP 直叩きで駆動し list/install/up/down/open/theme を実クリック確認、5/5 安定）。**
        Windows 実 backend の UI 動作確認は Phase 4/5 の節目。
      - 4b-fix(361e380): browser-dev の **Start/Stop 約2/3で無反応**を修正。dev mock の disposer が
        `snapshotPushers.clear()` でグローバル全消し + StrictMode の捨てマウント遅延 cleanup が live 購読を
        巻き込み pusher=0 に→ up/down の snapshot が誰にも届かない（初回 snapshot は配信済みで list は正常
        に見える）。mock を install 冪等・disposer no-op のページ寿命 singleton に。実 backend は mock 非
        搭載で影響なし。**vitest/happy-dom は import 解決順レースを再現せず、実 chromium+CDP で特定。**
      - 4c〜4f: dialogs(trust/delete/duplicate/import) → detail タブ(build/runtime log・services・settings) →
        banners/drag-drop/open/export + parity 総点検 + scaffold 残骸掃除(README/AGENTS/`shadcn` dep)。
- [ ] Phase 5 — parity + docs + 退役（+ Windows 実機確認 #3）
