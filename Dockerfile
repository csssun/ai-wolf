# 选择官方 Deno 镜像
FROM denoland/deno:alpine-1.44.3

WORKDIR /app

# 复制你的全部项目文件到镜像
ADD . /app

# 安装依赖包（可选，Deno 默认自动缓存依赖）
RUN deno cache main.ts

# Render 会传递 PORT 环境变量，这里用它
ENV PORT=800

CMD ["deno", "run", "-A", "--unstable", "main.ts"]
