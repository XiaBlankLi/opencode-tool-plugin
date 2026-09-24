# 安装手册

## 前置要求

| 依赖 | 说明 | 版本要求 |
| --- | --- | --- |
| VS Code | 代码编辑器 | `^1.75.0` 及以上 |
| opencode CLI | 会话服务（可选，仅恢复会话时需要） | 最新发布版 |

> opencode CLI 可通过 `PATH` 或环境变量 `OPENCODE_EXE` 指定位置，参见 [使用手册 - 环境变量](USAGE.md#环境变量)。

---

## 方式一：VSIX 安装（推荐）

`release/opencode-tool-plugin-0.0.1.vsix` 为已打包好的插件安装包。

1. 打开 VS Code
2. 打开扩展面板：`Ctrl+Shift+X`
3. 点击右上角 `...` 菜单 → **Install from VSIX...**
4. 选择 `opencode-tool-plugin-0.0.1.vsix`
5. 安装完成后按提示 **Reload Window**（`Ctrl+Shift+P` → `Developer: Reload Window`）

## 方式二：单文件安装脚本

`release/OpenCode工具插件安装(2026-09-24).txt` 是一个内嵌所有插件文件的 PowerShell 安装脚本（可离线使用）。

1. 复制该 `.txt` 文件到任意位置，重命名为 `.ps1`
2. 右键 → **使用 PowerShell 运行**（或 `powershell -ExecutionPolicy Bypass -File xxx.ps1`）
3. 脚本会自动解包文件到 VS Code 扩展目录并输出校验信息
4. 完成后 **Reload Window**

## 方式三：源码直接复制

1. 将仓库根目录复制为：

```
%USERPROFILE%\.vscode\extensions\opencode-tool-plugin-0.0.1
```

2. 确认目录下包含 `extension.js`、`package.json`、`media/`
3. 重启 VS Code

## 验证安装

- 命令面板（`Ctrl+Shift+P`）搜索到 **`OpenCode工具插件：打开侧栏`**
- 执行该命令后，最右一列出现 `OpenCode工具插件` 面板
- 打开一个 `opencode` 终端页签，面板自动出现

## 卸载

1. 扩展面板 → 找到 **OpenCode工具插件** → 垃圾桶图标
2. 或直接删除安装目录 `%USERPROFILE%\.vscode\extensions\opencode-tool-plugin-0.0.1`