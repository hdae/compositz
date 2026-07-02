# syntax=docker/dockerfile:1.7
#
# Cocktail (hdae/cocktail) を「Dockerfile 内で clone して自己完結ビルド」する compositz
# レシピ。上流の Dockerfile は apps/client/dist をホストで事前ビルド済みである前提だが、
# compositz のビルドコンテキストにはこのファイルしか無いので、clone → client dist ビルド
# → llama CUDA wheel ビルド → runtime 組み立て、までを 1 枚で完結させる。llama-builder /
# runtime の各段は上流 Dockerfile を逐語踏襲し、差分は「ソースを clone/build 段から COPY
# する」点と「client/dist を自前で作る」点だけに閉じ込める。

ARG COCKTAIL_REPO=https://github.com/hdae/cocktail
ARG COCKTAIL_REF=c74dec758197ef2f73246a208cb019963389dd59

# ==============================================================================
# Stage 0 — source
# pin した ref を浅く clone する。上流はビルドコンテキストにソースを置く前提だが、
# ここではネットワーク経由で取得して以降の段へ配る。
# ==============================================================================
FROM alpine/git AS source
ARG COCKTAIL_REPO
ARG COCKTAIL_REF
WORKDIR /src
RUN git clone "${COCKTAIL_REPO}" . && git checkout "${COCKTAIL_REF}"

# ==============================================================================
# Stage 1 — client-builder
# apps/client/dist を生成する。上流 Dockerfile は `.dockerignore` で client/src を除外し、
# ホスト側での `pnpm --filter @cocktail/client build` 済みを前提にしているため、自己完結
# ビルドではこの段を内包して dist を用意する。pnpm は packageManager 固定を corepack が解決。
# ==============================================================================
FROM node:22-slim AS client-builder
RUN corepack enable
WORKDIR /src
COPY --from=source /src /src
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @cocktail/client build

# ==============================================================================
# Stage 2 — llama-builder （上流逐語）
# llama-cpp-python を CUDA(sm_86/89/120) 有効でソースビルドし wheel を作る。事前ビルド
# wheel の CUDA カーネルは Blackwell(sm_120) で動かないため対象アーキ向けに自前コンパイル。
# 重い CUDA toolkit はこの builder にだけ置き、ランタイムイメージは軽量に保つ。
# ==============================================================================
FROM nvidia/cuda:12.8.1-devel-ubuntu22.04 AS llama-builder
# lock とバージョンを合わせること（apps/server/pyproject.toml / uv.lock）。
ARG LLAMA_CPP_VERSION=0.3.32
# 86=Ampere(RTX30xx), 89=Ada(RTX40xx), 120=Blackwell(RTX50xx)。
ARG CUDA_ARCHITECTURES=86;89;120
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
# GGML_CUDA を有効化し、対象アーキのカーネルを焼いた wheel を /wheels に出力する。
ENV CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES}"
# uv には `pip wheel` サブコマンドが無い（uv pip は compile/sync/install/... のみ）。uv は
# managed な Python 3.12 + pip の用意にだけ使い、CUDA ビルド自体は pip wheel で行う。
# llama-cpp-python の scikit-build-core が CMAKE_ARGS を読むため sm_120 有効の wheel が焼ける。
# runtime の uv venv も 3.12 なので wheel タグ(cp312)が一致し、そのまま uv pip install できる。
RUN uv venv --seed --python-preference only-managed --python 3.12 /opt/build-venv \
 && /opt/build-venv/bin/pip wheel \
        --no-binary llama-cpp-python \
        "llama-cpp-python==${LLAMA_CPP_VERSION}" \
        --wheel-dir /wheels

# ==============================================================================
# Stage 3 — runtime （上流逐語 + ソースは clone/build 段から COPY）
# torch / transformers / diffusers はイメージに焼かず、entrypoint の `uv sync` で
# 永続 volume に入れる。llama-cpp-python だけは CUDA ビルドが要るので builder の
# wheel を持ち込む。HOST/PORT は publish が確実に届くよう明示する。
# ==============================================================================
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # uv: .pyc は生成させ、Python 自体も uv に取得させる。link mode は既定の
    # hardlink のまま — cache と venv は compositz プリセット下でも standalone
    # でも同一 volume 上にあり、万一跨いでも uv が copy に自動フォールバックする。
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_PREFERENCE=only-managed \
    # 以下のパス群は standalone（compositz を介さない docker run）用のデフォルト。
    # compositz 配下ではレシピの cache: プリセットがコンテナ作成時 Env として
    # 上書きし（作成時 Env は image ENV に勝つ）、venv / uv cache / Python / HF /
    # 重みは共有キャッシュ volume へ移る。/workspace に残るのは IMAGES_DIR
    # （生成画像 = ユーザーデータ）のみ (ADR-024)。
    UV_PYTHON_INSTALL_DIR=/workspace/.uv-python \
    UV_PROJECT_ENVIRONMENT=/workspace/.venv \
    UV_CACHE_DIR=/workspace/.uv-cache \
    HF_HOME=/workspace/models \
    IMAGES_DIR=/workspace/images \
    WEIGHTS_DIR=/workspace/weights \
    HOST=0.0.0.0 \
    PORT=8000
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        libgomp1 \
        libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
# builder でビルドした CUDA llama-cpp-python wheel。entrypoint の uv sync が使う。
COPY --from=llama-builder /wheels /opt/wheels
WORKDIR /app
# 依存解決に必要なメタデータとソース。client は生成済み dist のみ（上流と同じ COPY 集合）。
COPY --from=source /src/pyproject.toml /src/uv.lock ./
COPY --from=source /src/apps/server/pyproject.toml ./apps/server/pyproject.toml
COPY --from=source /src/apps/server/src ./apps/server/src
COPY --from=client-builder /src/apps/client/dist ./apps/client/dist
COPY --from=source /src/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
