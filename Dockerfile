FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

# 安装纯净精简生产依赖 (仅需原生 ws 协议库，彻底剔除 C++ 二进制 ONNX/图像框架)
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev --no-audit && \
    rm -rf /root/.npm \
           node_modules/**/README.md \
           node_modules/**/CHANGELOG.md \
           node_modules/**/.github \
           node_modules/**/test \
           node_modules/**/tests \
           node_modules/**/examples

# -------------------------------------------------------------
# 运行环境：精简至极致 (压缩后传输仅约 20MB)
# -------------------------------------------------------------
FROM node:22-bookworm-slim

WORKDIR /app

ENV TZ=Asia/Shanghai \
    PORT=8571 \
    CTYUN_DATA_DIR=/app/data \
    ECLOUD_PYTHON=/usr/bin/python3 \
    ECLOUD_CRED_FILE=/app/data/ecloud_credentials.json \
    ECLOUD_SESSION_FILE=/app/data/ecloud_sessions.json \
    ECLOUD_LOGIN_RATE_LIMIT_FILE=/app/data/ecloud_login_rate_limit.json

# ca-certificates：天翼云 HTTPS
# python3 + requests + pycryptodome：移动公众协议侧车（app/ecloud_engine/sidecar.py）运行时；
#   它由 Node 以子进程方式托管，与 Node 本体的保活逻辑互不重叠。
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone && \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates python3 python3-pip && \
    pip3 install --no-cache-dir --break-system-packages \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        requests pycryptodome && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache

# 从构建阶段拷贝极速轻量 node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY app ./app
COPY server.js ./

# 侧车源码不携带任何 Python 字节码缓存，保持镜像干净
RUN find /app/app/ecloud_engine -name '__pycache__' -type d -prune -exec rm -rf {} + || true

EXPOSE 8571

VOLUME ["/app/data"]

CMD ["node", "server.js"]
