# Tauri 全面移行計画 (2026-07-03 策定 / 同日ユーザー承認)

> **✅ 完遂 (2026-07-05)**: Phase 0〜5 すべて完了。決定の恒久記録は
> [ADR-028](../decisions.md)、現行アーキテクチャは [architecture.md](../architecture.md)。
> 本書と [tauri-migration-execution.md](tauri-migration-execution.md) は実行当時の
> 計画の歴史的記録として保存する（技術選定表の一部は実行中に更新された —
> 例: HTTP client は reqwest → ureq, ADR-027 / tauri-specta は rc.25 → rc.21 pin）。

**承認状況**: 計画全体 + 要判断 5 点のデフォルト（serde_norway / tauri-specta exact pin /
router・Query なし開始 / shadcn preset nova / pnpm devEngines 10.32.1 固定）すべて承認済み。

**実施体制 (ユーザー指定)**: 実装は **Opus サブエージェント**（Workflow で並列編成）、 **Fable
は監督**（フェーズ設計・レビュー・敵対検証・統合判断・完了報告）。機械的作業は Sonnet/Haiku
に降ろしてよい。各 Phase の成果は監督が検証してからコミット。 **Phase 1 以降の体制変更
(2026-07-03)**: Fable 不在・**Opus 単独遂行**。詳細手順と例外時対応は
[tauri-migration-execution.md](tauri-migration-execution.md)（本書の実行詳細版）に従うこと。

**進捗**: Phase 0 ✅ 完了（2026-07-03、Windows 実機検証済み — NSIS インストール → 一覧/logs/events
ストリーミング動作。★npipe 長時間ストリーミングのリスクは実測で消滅）。

**決定** (ユーザー承認済み): Deno Desktop/Fresh を捨て、Tauri 2 + Rust core (bollard) + React SPA +
Shadcn (Base UI) へ全面移行する。update アークは凍結し移行後に新スタックで実装。
同一リポジトリで既存 `packages/` と並存させ、パリティ達成後に退役。

検証済み根拠: 調査ワークフロー 2 本（deno desktop 成熟度 / 本移行の技術検証）。特に本環境での
**実機検証済み**: ①vp 0.2.2 scaffold + shadcn CLI 4.12 `--base base` が end-to-end で動作、 ②模擬
Cargo workspace（default-members=[core,cli]）が webkit なしで headless ビルド/テスト緑、 ③bollard が
`tcp://host.docker.internal:2375` の実エンジンに接続成功、 ④`cargo check -p desktop` は dbus/webkit
不在で失敗（= desktop は CI ビルド、が正しい）。

## 最終構成

```
compositz/
├── Cargo.toml              # workspace: members=[crates/*], default-members=[core, cli]
├── crates/
│   ├── core/               # bollard engine 層 + manifest/ingest/instance/run/operations
│   ├── cli/                # clap。static binary (Linux headless 配布が単一バイナリ化)
│   └── desktop/            # Tauri 2 app。tauri.conf.json はここ (root "desktop/" は使わない)
├── frontend/               # pnpm 独立プロジェクト (root に package.json を置かない)
│   └── (vp + React 19 + Tailwind v4 + shadcn Base UI)
├── packages/               # 既存 Deno (凍結・並存 → Phase 5 で退役)
└── .github/workflows/      # main-push/manual: Windows artifact / release: tauri-action
```

- **IPC**: request/response = Tauri commands、ストリーム (logs/install progress/snapshot) =
  `tauri::ipc::Channel`（events は低スループット用のため使わない）。HTTP+SSE は全廃 — **localhost に
  port を開かない**（セキュリティ改善）。
- **State**: `.manage(Mutex<AppState>)`、std Mutex 基本（guard を await 跨ぎで持つ箇所のみ tokio）。
- **Plugins**: opener（旧 /api/open）/ single-instance（最初に登録）/ dialog / log / window-state。
  updater は署名鍵が要るためリリース準備期に。
- **Frontend**: router なし・TanStack Query なしで開始（現アプリは SSE push 型 = Channel push →
  zustand store が素直。Query は pull/cache 型で不整合。必要になったら足す）。 dark mode = shadcn
  Vite ThemeProvider（class + localStorage + system 既定 — ADR-019 と同義）。

## 技術選定（調査済み）

| 領域               | 採用                                                                                         | 備考                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker client      | bollard                                                                                      | npipe/TCP/unix、全 API 1:1。version は Phase 0 で確定（0.19.4 で TCP 検証済 / 最新 0.21 は feature 構成を要確認）                                                                                                                 |
| YAML               | serde_norway                                                                                 | RustSec 推奨の serde_yaml 後継 fork、drop-in。serde-saphyr は 1.0 到達時に再訪。serde_yml は RUSTSEC-2025-0068 につき禁止                                                                                                         |
| JSON Schema        | schemars 1.0                                                                                 | zod + gen_schema.ts の後継。境界は serde `deny_unknown_fields` で fail-loud                                                                                                                                                       |
| Archive            | tar-rs + flate2 (**MultiGzDecoder**) + zip (CVE-2025-29787 修正版)                           | 展開時 zip-slip 検査。tokio-tar/async-tar は TARmageddon につき禁止。ingestion は spawn_blocking                                                                                                                                  |
| HTTP               | reqwest 0.13 + rustls                                                                        | 単一 Client 再利用、read_timeout、bytes_stream                                                                                                                                                                                    |
| Error              | thiserror (crates) / anyhow (bins) / serde tagged enum (Tauri 境界 → TS discriminated union) |                                                                                                                                                                                                                                   |
| その他             | tracing / tempfile `NamedTempFile::persist`(new_in + sync_all) / directories / dunce         | **config.yaml 非atomic write の既知問題は移植で構造的に解消**                                                                                                                                                                     |
| 型付き IPC         | tauri-specta `=2.0.0-rc.25` (exact pin)                                                      | Rust 型 → TS 生成で二重定義ゼロ。RC のため exact pin + upgrade 時 smoke test                                                                                                                                                      |
| Frontend toolchain | **vp (vite-plus 0.1.24 系で統一)**                                                           | 0.2.x は `@voidzero-dev/vite-plus-test` に bin 未同梱で `vp test` 不能 → 0.1.24 が最新の整合セット（catalog で pin、test 0.2.x が出たら再訪）。tauri.conf は `pnpm dev`/`pnpm build` 間接参照 → vp⇄Vite 乗換コスト = Tauri 側ゼロ |

### 実機検証で判明した注意点（must-fix、Phase 0 に組込）

1. **pnpm major 統一**: vp 既定は pnpm 11 自前 DL → ambient pnpm 10 と lockfile 非互換で shadcn init
   が壊れる。 → scaffold の `devEngines.packageManager.version` を `10.32.1` に固定（検証済）。
2. **tsconfig**: TS 6.0 では `baseUrl` 禁止（TS5101）。`paths {"@/*":["./src/*"]}` のみを両 tsconfig
   に。
3. **shadcn init は `--preset` 明示必須**（非対話）。`--base base --preset nova` を検証済。
4. **.gitignore**: `/target/` 追加、frontend dist 追加。root `desktop/`
   は使わない（レイアウト一貫性。 当初根拠の「既存 `/desktop/` エントリに飲まれる」は誤りと判明 —
   その行は行内コメント付きで gitignore 的に何にもマッチしない死にエントリ。Deno
   ツリー退役時に整理）。
5. **root deno.json** の fmt/lint exclude に `crates/`・`frontend/`
   を追加（新旧ツールチェーンの喧嘩防止）。
6. `.vscode/settings.json`: `rust-analyzer.check.workspace: false`（default-members を IDE flycheck
   が無視するため）。
7. vitest は happy-dom（jsdom は WebCrypto 欠落で mockIPC が死ぬ）。`@tauri-apps/api` exact pin +
   「Channel が mockIPC 下で届く」smoke test（実装挙動依存のため regression 検知を仕込む）。
8. **tauri.conf の hook は object 形式 + 明示 cwd 必須**: 文字列形式の beforeDev/BuildCommand は CLI
   が自動解決した frontend dir を cwd にする。crates/desktop 配下に package.json が無い本構成では
   crates/ にフォールバックし `../../frontend` がリポジトリ外へ逃げて Windows CI が cargo 実行前に
   死ぬ（実 CLI で再現・修正検証済み）。`{ "script": "pnpm build", "cwd": "../../frontend" }` 形式を
   使う。NOTE: tauri-cli 実装挙動依存（仕様保証ではない）— CLI 更新時に要再確認。

## 開発ループ（この headless 環境で）

- Rust: devbox `rustup` + stable。`cargo build/test`（root）= core+cli のみ（検証済）。 core
  統合テストは env-gate（`COMPOSITZ_DOCKER_HOST` 未設定なら skip）→ ここでは TCP 実エンジン、 CI
  ubuntu では unix socket。
- Frontend: `vp dev` + ブラウザ（forwarded port）。dev 起動時 `__TAURI_INTERNALS__` 不在なら mockIPC
  注入。
- **desktop crate と installer は CI (windows-latest) のみ**。cargo-xwin は WSL 固有バグ (#13829)
  につき不使用。
- CI 2 本: (a) main-push(paths filter)/manual = tauri-action@v1 で tagName 省略 + `artifactPaths` →
  upload-artifact（ユーザーが NSIS/MSI を DL して手動確認。未署名なので SmartScreen 警告は仕様。
  main 直コミット運用のため PR trigger は置かない）、(b) release = tag 付き。

## フェーズ

- **Phase 0 — 足場 + walking skeleton**: rustup 導入、gitignore/exclude/vscode 整備、workspace + 4
  領域の雛形（core: bollard 接続 + label-filter ps / cli: ps コマンド / desktop: 最小窓 + container
  一覧 command + logs **Channel** 1 本 / frontend: vp + shadcn + 一覧表示）、CI、 **Windows artifact
  をユーザーが実機確認**。 ★ここで唯一の残存技術リスク「**npipe 上の長時間 events/logs
  ストリーミング**」を実測で潰す。 vp の cargo tauri 結線 end-to-end 確認もここ（fable 検証の残留保
  2 点を同時に解消）。
- **Phase 1 — core 移植 (test-first)**: manifest → errors/brand/storage → instance store（atomic
  write）→ github → ingest → run(persistedMounts) →
  operations(up/down/install/delete/export/duplicate)。 既存 ~1,860 行のテストを仕様として移植。ADR
  の pitfalls 一覧をレビューチェックリスト化 （削除安全性 / export helper teardown 順序 / id 検証 /
  deconflict / MultiGzDecoder…）。
- **Phase 2 — CLI 移植**: 11 コマンド (clap)。
- **Phase 3 — desktop backend**: commands + Channels（現 API route 相当: list/action/config/logs/
  events相当 snapshot/import/export/open）、ADR-026 の readiness 設計移植（HTTP probe / warming poll
  / serialize+coalesce）。
- **Phase 4 — React UI**: InstanceList.tsx (1,434 行モノリス) をコンポーネント分解して再構築。
  trust/削除/複製 dialog、タブパネル、Settings、dark mode、通知。ADR-020/023/025/026 の挙動パリティ
  チェックリストで検証。
- **Phase 5 — パリティ確認 + docs 大改訂 + 退役**: 新 ADR（移行決定/スタック）、ADR-007/008/016/018
  等に superseded 記録、README/roadmap/CLAUDE.md 更新、known-issues 棚卸し（atomic write
  等は解消済に）、 `packages/` `bin/deno` `deno.json` 削除。

各 Phase 完了時: `cargo test` + `cargo clippy` + `vp check` + `vp test` 緑 + Conventional Commit。
Windows 実機確認が必要な節目（Phase 0 / 3 / 5）で artifact を渡して番号付き手順で依頼。

## 参考

- 先行事例: Dockyard (github.com/ropali/dockyard) = Tauri+React+bollard の Docker GUI —
  パターン参照元。
- 調査の一次情報は session workflow 出力に保存（要点は本ファイルと memory に転記済み）。
