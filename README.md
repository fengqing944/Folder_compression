# 文件夹压缩工具

一个 Tauri 桌面小工具，用 RAR 命令行将拖入的文件夹压缩成 RAR，并可选使用 7-Zip 做二次压缩。

## 功能

- 拖拽文件夹到程序，或点击选择文件夹。
- 文章 ID 必填；启用创建文件夹时，输出到同级的文章 ID 文件夹。
- 支持压缩包前缀规则：例如添加 `Nyako喵子 -> nyako` 后，`Nyako喵子 夏日写真` 会生成 `nyako_142631.rar`。
- 已内置旧版 `keyword_mappings.json` 中的默认规则，首次启动会自动写入新版配置。
- 支持导入旧版 `keyword_mappings.json`，兼容 `"关键词": "前缀_"` 格式。
- 支持二次压缩：先生成 RAR，再把 RAR 或 RAR 分卷打包成 7z。
- 支持删除中间 RAR，只保留 7z。
- 支持后台模式，隐藏 RAR/WinRAR 和 7-Zip 窗口。
- 支持显式 RAR 密码、加密文件名，并在压缩后测试 RAR 压缩包。
- 二次压缩时 7z 密码默认跟随 RAR 密码，减少两层密码不一致。
- 支持超过 500MB 后按 500MB 分卷。
- 压缩前会清理同名旧 RAR、7z 和 RAR 分卷，避免旧文件残留到新压缩包。
- 默认优先使用 `Rar.exe` 执行压缩，密码、加密文件名和测试压缩包都由程序显式传参；找不到时回退 `WinRAR.exe`。
- 分卷大小会校验格式，例如 `500m`、`1g`、`102400k`。
- 压缩完成或失败后发送系统通知。
- 使用 Tabs 区分压缩任务、前缀规则、路径与日志。
- 自动保存并恢复窗口位置、大小和最大化状态。
- 默认工具路径：
  - WinRAR/RAR：`G:\Software\WinRAR\WinRAR.exe`
  - 7-Zip：`C:\Program Files\7-Zip\7z.exe`

## 开发

```powershell
npm install
npm run tauri dev
```

## 构建

```powershell
npm run tauri build
```

构建后的安装包位于：

`src-tauri\target\release\bundle\nsis\`
