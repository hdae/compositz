# Active Design — current focus

> Short index of in-flight design. Keep to a screenful. Full rationale lives in `docs/`. (旧
> Fresh/Deno 期の詳細は git 履歴と `docs/decisions.md` にある — このファイルは常に「今」だけ。)

## Current focus

**Tauri 全面移行 — Phase 1（core）+ Phase 2（CLI）完了。次は Phase 3（desktop backend）。** 計画:
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
- **Docker は TCP で到達**: `COMPOSITZ_DOCKER_HOST=tcp://host.docker.internal:2375`（この dev 環境
  自体が同じ engine 上の container — 統合テストは compositz-test-* 命名 + 正確な id で後始末、
  prune/一括系 絶対禁止、共有 cache volume に触れない）。
- **楽観的更新はしない**（ユーザー明示 — memory [[feedback-avoid-optimistic-ui]]）。
  server-confirmed state か明確な rollback のみ。

## Resume point

**Phase 1（core）+ Phase 2（CLI）完了**。Phase 2(fe4f7f4): 11 コマンド clap 化。core 追補
= engine ping/version/wait_container/create_container_simple + store系 re-export + engine
`list_instances`→`list_managed_containers` 改名(store 版に名前を明け渡す)。★F5 境界検証を全破壊
パスに適用(down/duplicate は inline、他は resolve_instance)。doctor は unix connect の eager 失敗
で診断出力を失う不具合を修正(`resolved_endpoint_description` で handle 非依存)。実機検証: doctor/ps/
ls/hello/import/duplicate/export一覧/rm/境界拒否。敵対的2視点レビュー済み。
**要判断(F1): core `duplicate_instance` を remove_instance_dir 同様に自己 validate させるか(現状 CLI
guard で安全・Phase 3 desktop の footgun 予防)。**
**NEXT: Phase 3 — desktop backend（commands + Channels、+ Windows 実機確認 #2）。** 現 API route
= `packages/ui/routes/api/` の現物が仕様(execution 計画の対応表)。tauri-specta 導入・stream lifecycle
解消・single-instance plugin 最初に登録。再開手順: memory index → execution 計画 Phase 3 → route 現物。
