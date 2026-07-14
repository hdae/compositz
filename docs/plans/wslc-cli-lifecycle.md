# wslc port relay — D-cli(`wslc create`+`wslc start` 委譲)実行計画

Status: **APPROVED**(2026-07-14 ユーザー承認「OK, D-cliを承認します」)。
実装開始は下記「実機事前チェック」3点の通過後。

## 背景(1段落)

wslc は published port の Windows 側 relay を**自身の create/start 経路でのみ**登録する
(ソース確定: `WSLCContainer.cpp:827` MapPorts は wslc の Start() 内のみ / 採用は
create か session 起動時 label 復元のみ / イベント駆動・label 駆動の live 採用は無し)。
docker API(dial-stdio)直の create では relay が付かず、`wslc container list` にも
出ない。3系統の調査(microsoft/WSL issue・コミュニティ・ソース全数)で「relay 要件を
外す knob・公式の代替 endpoint・計画」はいずれも**不存在**と確定。よって wslc endpoint
時のみ container の create+start を wslc CLI に委譲し、native relay に乗る。

## 確定事実(実装が依拠する根拠)

| 事実 | 根拠 |
|---|---|
| CLI・dial-stdio doorway・`wslc create/start/list` は同一 default セッション(同一 dockerd) | 実機 E2(docker ps 同居)+ `SessionTasks.cpp` OpenOrCreateDefaultSession |
| `wslc create` は `--name/--label/--env/--env-file/-p/-v/--entrypoint/--gpus/--shm-size/--stop-signal/--stop-timeout` 等を受理 | `ContainerCreateCommand.cpp:29-77` |
| 外部(docker API)からの stop/rm は wslc がイベント追随し relay 解除+帳簿掃除 | `WSLCContainer.cpp:883-931`(OnEvent Stop/Destroy)→ `ReleaseRuntimeResources` → `UnmapPorts`(`:2318-2325`) |
| `wslc run/create -p H:C` は moby へは **VmPort(内部採番)** で publish し、H は Windows 側 relay + label `com.microsoft.wsl.container.metadata`(V1, HostPort/VmPort/ContainerPort)に記帳 | 実機(portprobe 20002)+ `WSLCContainerMetadata.h` |
| セッションはユーザー毎 default 1個・Persistent(アプリ終了後も relay 存続) | `WSLCSessionManager.cpp:193-198` + 実機 session list |
| C DLL(wslcsdk)は named settings+Consomme ハードコードで default セッションに入れない(不採用確定) | `wslcsdk.cpp:420-445` |
| COM Compat 層は null-Settings で default セッション attach 可(後方互換明文)— fallback として温存 | `WSLCCompat.idl` 冒頭 / `WSLCSessionManager.cpp:661-663` |

## 設計

### 変更点(wslc endpoint 時のみ分岐)

1. **分岐点は `start_with` 一箇所**([operations.rs:182](../../crates/core/src/recipe/operations.rs))。
   endpoint kind が wslc のとき、`to_create_spec` が返す同一の `ContainerCreateBody` から
   **argv を射影**して `wslc create ...` + `wslc start <name>` を spawn する。
   bollard 経路と wslc 経路の**真実源は同じ body**(二重実装を作らない)。
2. **新モジュール `crates/core/src/wslc_cli.rs`**:
   - `wslc_create_args(body, name) -> Result<Vec<OsString>>` — 純関数、単体テスト対象。
     - Env → **常に `--env-file`**(一時ファイル、ユーザー %TEMP%、spawn 後削除)。
       理由: 引数長制限(~32KB)回避・quoting 非依存・HF_TOKEN 級 secret をプロセス
       コマンドラインに露出しない。値に改行を含む env は**拒否**(fail loud、KEY=VALUE
       行形式で表現不能)。
     - Labels → `--label KEY=VALUE` 反復(io.compositz.* は charset 安全)。
     - PortBindings → `-p <host>:<container>` 反復(プロトコルは tcp のみ、udp が
       将来出たら fail loud)。
     - Mounts: named volume → `-v name:/path`(readonly は `:ro`)。
       **bind mount は Error**(wslc の `-v` は Windows パス virtiofs で意味が変わる。
       bindDir 対応は別スライス — limitations に記録)。
     - DeviceRequests(gpu) → `--gpus all`。Entrypoint → `--entrypoint`(配列 2 要素
       以上は fail loud、現 manifest では単一のみ)。
     - 表現できない body フィールドが**非デフォルト値**なら Error(黙って落とさない)。
   - `create_and_start_via_wslc(name, body)` — `wslc create` → `wslc start` を
     tokio::process で実行。`CREATE_NO_WINDOW`、kill_on_drop、タイムアウト(120s)、
     非 0 exit は stderr 全文を Error に(ローカライズ文はそのまま透過)。
3. **EngineHandle に endpoint kind を保持**(connect 時の `Endpoint` から)。
   `start_with` と下記 4 の分岐に使う。
4. **port 翻訳を list 層の一点に**: wslc endpoint 時、managed container listing の
   `public_port` を label `com.microsoft.wsl.container.metadata` の
   (VmPort→HostPort) で翻訳(private port 一致で対応付け)。label 欠落時はそのまま。
   これで a) view の Services live join、b) `resolve_ports` の衝突検査(auto-bump)、
   c) readiness probe の宛先、の三者が**同時に** Windows 側番号空間で正しくなる。

### 変更しない点

- `down`(stop+rm)・delete・update・duplicate: 現行 docker API のまま
  (wslc がイベント追随、上表)。
- build / logs / events / snapshot / exec / volumes: 現行 bollard via dial-stdio。
- export 安全弁の helper container: ports 無し・一時的 → bollard のまま
  (wslc セッション再起動時に「Failed to recover」警告が出る可能性は容認、transient)。
- compositz CLI(`up`)は core 共有なので自動的に同じ挙動 — relay が wslc サービス
  持ちのため **CLI 終了後も port が生きる**(Docker Desktop とのパリティ改善)。

### Fallback(実装しない、記録のみ)

D-com: Compat COM(`CoCreateInstance` CLSID a9b7a1b9-0671-405c-95f1-e0612cb4ce8f →
`IWSLCCompatSessionManager::CreateSession(nullptr)` = default セッション attach →
`CreateContainer`+`Start`)。CLI 面が preview で壊れた場合の代替。留保:
OpenExisting 系 API の形は MSFT が保留中(microsoft/WSL#40990, #40997 florelis 発言)。

## 実機事前チェック(実装開始ゲート、PowerShell)

```powershell
# ① named volume 構文
wslc volume create testvol
wslc create --name probe4 -v testvol:/data nginx
wslc system session run docker inspect probe4 --format "{{json .Mounts}}"   # named volume で /data に付くこと
wslc rm probe4; wslc volume remove testvol

# ② ローカル限定イメージを create しても pull を試みないこと
wslc system session run docker tag nginx local/only:test
wslc create --name probe5 local/only:test    # 成功すること(レジストリ照会で失敗しないこと)
wslc rm probe5
wslc system session run docker rmi local/only:test

# ③ 中核仮説の end-to-end: CLI create+start の relay と、外部 stop/rm への追随
wslc create --name probe6 -p 8086:80 nginx
wslc start probe6
# → ブラウザ http://localhost:8086 が開くこと
wslc system session run docker stop probe6
wslc system session run docker rm probe6
wslc container list        # probe6 が消えていること
# → http://localhost:8086 が不達になっていること
```

①②③すべて期待どおりなら実装開始。どれかが崩れたら設計へ戻る(③の追随が
崩れた場合は down も wslc CLI 委譲に変更)。

## コミット分割

| # | type(scope) | 内容 |
|---|---|---|
| 1 | feat(core) | EngineHandle の endpoint kind 保持 + `wslc_cli.rs`(argv 射影 + env-file + 単体/fault テスト) |
| 2 | feat(core) | `start_with` の wslc 分岐(create+start 委譲)、bind 拒否、unrepresentable 検査 |
| 3 | feat(core) | list 層の VmPort→HostPort label 翻訳 + 合成 label テスト |
| 4 | docs | ADR-031(D-cli 決定・証拠・棄却案)、limitations(bindDir/env改行/#41052)、roadmap・ACTIVE_DESIGN 更新 |

## 検証

- ローカル: argv 射影の単体テスト(既存 wire-shape fixture と同素材)/ bind・改行 env
  ・多要素 entrypoint の fail-loud fault テスト / 翻訳の合成 label テスト /
  fmt+clippy+test 全緑。
- 実機(ユーザー、番号付き手順は実装完了報告で提示): wslc endpoint で
  import→install→up → バッジ wslc·online / `wslc container list` に compositz-* が
  ports 付きで表示 / ブラウザ localhost:port 到達 / ready 遷移+Services Open /
  down で list から消え port 不達 / アプリ終了後も port 生存(up し直し→終了→到達)。

## 留保・記録事項

- wslc CLI は preview — フラグ改名リスクは実機チェックと fail-loud で受ける。
  `--env-file` の値パース(quoting 有無)は実装時に `ContainerModel.cpp` で確認。
- moby 側 PublicPort(VmPort)と Windows 側 HostPort の**二重番号空間**は label 翻訳で
  吸収(翻訳点は 1 箇所)。
- 既知 upstream バグ: TCP publish が大量接続(~5000)で失速(microsoft/WSL#41052)。
- bindDir は wslc では未対応(fail loud)→ 将来スライスで wslc `-v <WindowsPath>`
  (virtiofs)へ写像すればむしろ docker API より良くなる。
- upstream 報告(dial-stdio 作成コンテナの relay/list ギャップ + 解析結果)は本実装と
  独立に価値あり — issue 文面ドラフトは別タスク。
