# syntax=docker/dockerfile:1
# ---------- build rapidsnark ----------
# rapidsnark pinned to iden3/rapidsnark commit
# 81eddf1a536d26497b237c0b8a04fe90baf7e439 (main HEAD as of 2026-09-17).
#
# Build follows the repo README "Compile prover in standalone mode" at that commit:
#   git submodule update --init --recursive
#   ./build_gmp.sh host        # x86_64  -> GMP static lib in depends/gmp/package
#   make host                  # cmake release build, installs to package/bin/prover
# or, for linux/arm64:
#   ./build_gmp.sh aarch64     # GMP static lib in depends/gmp/package_aarch64
#   make host_arm64            # installs to package_arm64/bin/prover
#
# Note: the historical `npx task build_prover` from older rapidsnark is gone at
# this commit (tasksfile.js now exports camelCase buildProver and the README
# documents the Makefile flow above), so we use the README flow directly.
# OpenMP is enabled on Linux -> prover links libgomp dynamically; GMP is static.
FROM node:20-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git curl xz-utils m4 nasm \
    && rm -rf /var/lib/apt/lists/*

ARG RAPIDSNARK_COMMIT=81eddf1a536d26497b237c0b8a04fe90baf7e439
RUN git clone https://github.com/iden3/rapidsnark.git /rapidsnark \
    && cd /rapidsnark \
    && git checkout "${RAPIDSNARK_COMMIT}" \
    && git submodule update --init --recursive

WORKDIR /rapidsnark
ARG TARGETARCH
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
      ./build_gmp.sh aarch64 && make host_arm64 \
      && cp package_arm64/bin/prover /usr/local/bin/prover; \
    else \
      ./build_gmp.sh host && make host \
      && cp package/bin/prover /usr/local/bin/prover; \
    fi

# ---------- runtime ----------
FROM node:20-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/prover /usr/local/bin/prover
WORKDIR /app
COPY server.ts /app/server.ts
RUN npm install -g tsx
EXPOSE 8080
# 电路产物（claim.wasm / generate_witness.js / claim_final.zkey）由 docker-compose
# 以只读 volume 挂到 /artifacts（ARTIFACTS_DIR 可覆盖）。
CMD ["tsx", "/app/server.ts"]
