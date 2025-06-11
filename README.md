# 🐺 AI 狼人杀 - 月夜传说

![狼人杀游戏](https://github.com/你的用户名/ai-wolf/raw/main/screenshots/game-preview.png)

一个基于 Deno 开发的在线多人狼人杀游戏，全程由 AI 主持，无需人工法官。支持实时语音交流，多种角色设定，适合 5-10 人游戏。

## ✨ 特性

- **AI 自动主持**：游戏全程由 AI 主持人自动引导，无需人工法官
- **实时对战**：基于 Socket.IO 的实时多人对战系统
- **支持多种角色**：狼人、平民、预言家等经典角色
- **自动配置**：根据玩家人数自动调整角色配置
- **AI 玩家**：可添加 AI 玩家补足人数
- **响应式设计**：适配桌面和移动设备
- **持久化存储**：使用 Deno KV 存储游戏状态，支持断线重连

## 🎮 游戏规则

### 人数与配置
- 支持 **5-10** 人游戏
- 房主可以添加 **AI 玩家** 补足人数
- AI 将根据玩家人数，自动配置狼人、平民及神职角色

### 游戏目标
- **好人阵营** (平民与神职): 白天投票放逐所有狼人
- **狼人阵营**: 夜晚猎杀，白天混淆视听，当狼人数量 ≥ 好人数量时获胜

### 游戏流程
1. 游戏开始，AI 私密分配身份
2. **【黑夜】**：AI 按顺序唤醒角色(狼人，预言家)。按提示选择目标
3. **【白天】**：AI 宣布夜间结果。玩家自由打字讨论
4. **【投票】**：AI 发起投票，按提示选择目标。票数最高者(平票随机)被放逐
5. 重复循环，直至一方胜利。游戏结束后自动重置房间

## 🚀 快速开始

### 在线试玩

访问我们的演示站点：[[ttps://ai-wolf.deno.dev](https://ai-wolf.deno.dev)](https://takatorury-ai-wolf-33.deno.dev/)

### 本地运行

1. 确保已安装 [Deno](https://deno.com/) (v1.37.0 或更高)

2. 克隆仓库
   ```bash
   git clone https://github.com/你的用户名/ai-wolf.git
   cd ai-wolf
   ```

3. 启动服务器
   ```bash
   deno task start
   ```

4. 在浏览器中访问 `http://localhost:8000`

## 🔧 技术栈

- **[Deno](https://deno.com/)**: 安全的 JavaScript/TypeScript 运行时
- **[Socket.IO](https://socket.io/)**: 实时双向通信
- **[Deno KV](https://deno.com/kv)**: 键值数据库
- **纯 JavaScript/CSS/HTML**: 无需前端框架

## 📋 项目结构

```
ai-wolf/
├── main.ts             # 主服务器文件
├── deno.json           # Deno 配置文件
├── static/             # 静态资源目录
│   ├── style.css       # CSS 样式
│   └── client.js       # 客户端 JavaScript
└── templates/          # 模板目录
    └── index.html      # HTML 主页
```

## 🔄 角色配置

游戏会根据玩家人数自动配置角色:

| 人数 | 狼人 | 预言家 | 平民 |
|------|------|--------|------|
| 5    | 1    | 1      | 3    |
| 6    | 2    | 1      | 3    |
| 7    | 2    | 1      | 4    |
| 8    | 3    | 1      | 4    |
| 9    | 3    | 1      | 5    |
| 10   | 3    | 1      | 6    |

## 🌐 部署

### 部署到 Deno Deploy

1. Fork 此仓库
2. 前往 [Deno Deploy](https://dash.deno.com) 创建新项目
3. 选择 "Deploy from GitHub"
4. 选择你 fork 的仓库
5. 设置入口点为 `main.ts`
6. 启用 Deno KV 功能

详细部署指南请参考 [部署文档](docs/deployment.md)

## 🤝 贡献

欢迎提交 Issues 和 Pull Requests！

1. Fork 此仓库
2. 创建您的功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交您的更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开一个 Pull Request

## 📝 开发计划

- [ ] 添加更多角色 (如：猎人、守卫等)
- [ ] 游戏历史记录
- [ ] 玩家账户系统
- [ ] 更多 AI 主持人风格
- [ ] 更先进的 AI 玩家策略

## 📜 许可证

MIT © [csssun]

## 📧 联系方式

如有问题或建议，请联系 [hi@661118.xyz]
