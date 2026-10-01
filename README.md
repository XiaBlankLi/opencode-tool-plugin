# OpenCode工具插件 (opencode-tool-plugin)

在 VS Code 中为 [opencode](https://opencode.ai) 提供专用编辑器页签与常驻侧栏，展示实时会话状态、历史对话，并可一键恢复历史会话继续对话。

> 仅用于本地演示与个人使用。插件内含的媒体资源（音频/GIF）版权归原作者所有，请勿用于公开分发。

![许可证](https://img.shields.io/badge/license-MIT-blue)
![版本](https://img.shields.io/badge/version-0.0.1-brightgreen)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.75.0-007acc)

## 功能特性

- **opencode 专用编辑器页签**：点击历史会话时，opencode 会以编辑器页签形式打开并恢复该会话，不使用底部终端面板
- **布局友好**：面板固定在最右一列，opencode 页签开在面板左侧一列（`文件 | opencode | 面板`），插件从不搬动、重建你已有的页签
- **常驻侧栏面板**：
  - 会话状态实时显示（模型、Agent、Context tokens、用量百分比、花费、LSP 状态），每 5 秒自动刷新
  - **可折叠的会话状态栏与模型列表**：状态栏展示当前对话、Context tokens、用量、花费、LSP、model 与 agent；其下方可折叠列出全部模型，并标注模型对 PDF / 图片 / 视频的支持能力
  - 历史对话列表，点击即可恢复对应会话；支持**重命名与删除**（删除带二次确认）
  - **关键内容提取**：一键提取会话中的核心观点与关键词，点击即复制到剪贴板并填入 opencode 输入框（用后自动清理临时会话）
  - **用户笔记**：在面板中记笔记，自动保存到 `~/.opencode-tool-notes.json`
  - **网易云音乐**：扫码/手机号登录、加载歌单、播放歌曲（需安装 `NeteaseCloudMusicApi` 依赖）；网易云模式自动隐藏切歌/轮播控件，图片区正常显示网易云专辑封面；来源按钮互斥置灰
  - 内置媒体播放器（播放/暂停/下一首、进度条），可播放本地音频
  - 动画轮播 GIF 背景
- **启动即用**：VS Code 打开即自动激活工具面板

## 快速开始

1. 本机已安装 VS Code（≥ 1.75.0）与 [opencode](https://opencode.ai) CLI
2. 安装插件，详见 [安装手册](docs/INSTALL.md)
3. 打开一个 opencode 终端，或执行命令 `OpenCode工具插件：打开侧栏`
4. 在面板点击任意历史会话，opencode 以页签形式恢复对话，详见 [使用手册](docs/USAGE.md)

## 目录结构

```
opencode-tool-plugin/
├── extension.js              # 插件主逻辑
├── ncm.js                    # 网易云音乐（NeteaseCloudMusicApi）封装
├── .vscodeignore             # 打包排除规则
├── package.json              # 插件清单（命令、激活事件）
├── media/                    # 面板媒体资源（图标、GIF、音频）
├── docs/
│   ├── INSTALL.md            # 安装手册
│   └── USAGE.md              # 使用手册
└── release/
    ├── opencode-tool-plugin-0.0.1.vsix    # VSIX 安装包
    └── OpenCode工具插件安装(2026-09-28).txt # 单文件安装脚本
```

## 开发与构建

```powershell
# 修改代码后校验语法
node --check extension.js

# 打包 VSIX（在仓库根目录执行）
npx --yes @vscode/vsce package --allow-missing-repository
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `OPENCODE_EXE` | 可选。指定 opencode 可执行文件的完整路径。未设置时自动在 `PATH` 与 npm 全局目录中查找。 |

## 许可证

[MIT](LICENSE)

## 版权声明

本项目中的动画与音频仅为本地演示素材，版权归其原作者所有。如需公开分发，请自行替换 `media/` 下的素材。